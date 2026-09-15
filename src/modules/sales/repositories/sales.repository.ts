import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { Sale } from '../entities/sale.entity';
import { SaleDocument } from '../entities/sale-document.entity';
import { SaleStatus } from '../enums/sale-status.enum';
import { DocumentKind } from '../enums/document-kind.enum';

const PEOPLE = {
  holder: true,
  secondContact: true,
  substituteHolder: true,
  beneficiaries: true,
} as const;

const LIST_STATUSES = [
  SaleStatus.COMPLETED,
  SaleStatus.PENDING_VALIDATION,
  SaleStatus.PENDING_SIGNATURE,
  SaleStatus.PENDING_PAYMENT,
  SaleStatus.REJECTED,
];

const CONCILIATION_STATUSES = [
  SaleStatus.COMPLETED,
  SaleStatus.PENDING_VALIDATION,
  SaleStatus.PENDING_SIGNATURE,
  SaleStatus.PENDING_PAYMENT,
];

const KEEP_BASE64_KINDS = new Set<DocumentKind>([
  DocumentKind.FIRMA,
  DocumentKind.TICKET_PAGO,
]);

function sortBeneficiaries(sale: Sale) {
  sale.beneficiaries = [...(sale.beneficiaries ?? [])].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
}

@Injectable()
export class SalesRepository {
  constructor(
    @InjectRepository(Sale)
    private readonly repo: Repository<Sale>,
    @InjectRepository(SaleDocument)
    private readonly documents: Repository<SaleDocument>,
  ) {}

  create(): Sale {
    return this.repo.create();
  }

  save(sale: Sale): Promise<Sale> {
    return this.repo.save(sale);
  }

  /**
   * Actualiza la venta y personas sin reescribir `sale_documents`
   * (evita volcar o pisar `data_base64`).
   */
  async saveWithoutDocuments(sale: Sale): Promise<Sale> {
    const docs = sale.documents;
    Reflect.deleteProperty(sale, 'documents');
    try {
      return await this.repo.save(sale);
    } finally {
      if (docs !== undefined) sale.documents = docs;
    }
  }

  saveDocument(doc: SaleDocument): Promise<SaleDocument> {
    return this.documents.save(doc);
  }

  /** Personas + docs: base64 solo si aún no está en Drive (o firma/ticket). */
  findById(id: number): Promise<Sale | null> {
    return this.loadSale(id, false);
  }

  /** Incluye todos los binarios (firma → Drive / sync Odoo). */
  findByIdWithFiles(id: number): Promise<Sale | null> {
    return this.loadSale(id, true);
  }

  /** Reutilizar captura: busca en todas las ventas por nombre/CURP/celular. */
  async searchReferencesByName(q: string, limit = 20): Promise<Sale[]> {
    const tokens = q
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .map((token) => token.replace(/[%_\\]/g, ''));
    if (!tokens.length) return [];

    const cap = Math.min(Math.max(limit || 20, 1), 50);
    const qb = this.repo
      .createQueryBuilder('s')
      .leftJoin('s.holder', 'h')
      .select('s.id', 'id')
      .addSelect('s.updated_at', 'updated_at')
      .where(
        '(s.status != :draft OR s.draft_expires_at IS NULL OR s.draft_expires_at > :now)',
        { draft: SaleStatus.DRAFT, now: new Date() },
      );

    tokens.forEach((token, i) => {
      const like = `%${token}%`;
      qb.andWhere(
        `(
          s.titular_name ILIKE :t${i}
          OR h.nombres ILIKE :t${i}
          OR h.apellido_paterno ILIKE :t${i}
          OR h.apellido_materno ILIKE :t${i}
          OR h.curp ILIKE :t${i}
          OR h.celular1 ILIKE :t${i}
          OR h.celular2 ILIKE :t${i}
          OR CAST(s.id AS TEXT) = :id${i}
        )`,
        { [`t${i}`]: like, [`id${i}`]: token },
      );
    });

    const rows = await qb.orderBy('s.updated_at', 'DESC').take(cap).getRawMany();
    const ids = rows
      .map((row) => Number(row.id))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (!ids.length) return [];

    const sales = await this.repo.find({
      where: { id: In(ids) },
      relations: PEOPLE,
      relationLoadStrategy: 'query',
    });
    const byId = new Map(sales.map((sale) => [sale.id, sale]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((sale): sale is Sale => Boolean(sale));
    for (const sale of ordered) sortBeneficiaries(sale);
    return ordered;
  }

  /** Listado del vendedor: solo fila `sales`. */
  findSummariesBySellerId(sellerId: number): Promise<Sale[]> {
    return this.repo.find({
      where: { sellerId },
      order: { updatedAt: 'DESC' },
    });
  }

  findForMonitor(): Promise<Sale[]> {
    return this.repo.find({
      where: { status: In(LIST_STATUSES) },
      order: { updatedAt: 'DESC' },
    });
  }

  findForConciliation(): Promise<Sale[]> {
    return this.repo.find({
      where: { status: In(CONCILIATION_STATUSES) },
      order: { updatedAt: 'DESC' },
    });
  }

  countActiveDrafts(sellerId: number, now: Date): Promise<number> {
    return this.repo
      .createQueryBuilder('s')
      .where('s.seller_id = :sellerId', { sellerId })
      .andWhere('s.status = :status', { status: SaleStatus.DRAFT })
      .andWhere('(s.draft_expires_at IS NULL OR s.draft_expires_at > :now)', {
        now,
      })
      .getCount();
  }

  async deleteExpiredDrafts(now: Date): Promise<number> {
    const result = await this.repo.delete({
      status: SaleStatus.DRAFT,
      draftExpiresAt: LessThan(now),
    });
    return result.affected ?? 0;
  }

  async deleteById(id: number): Promise<void> {
    await this.repo.delete(id);
  }

  private async loadSale(
    id: number,
    withBase64: boolean,
  ): Promise<Sale | null> {
    const sale = await this.repo.findOne({
      where: { id },
      relations: PEOPLE,
      relationLoadStrategy: 'query',
    });
    if (!sale) return null;
    sortBeneficiaries(sale);
    sale.documents = await this.loadDocuments(id, withBase64);
    return sale;
  }

  private async loadDocuments(
    saleId: number,
    withBase64: boolean,
  ): Promise<SaleDocument[]> {
    if (withBase64) {
      return this.documents.find({ where: { saleId } });
    }

    const docs = await this.documents.find({
      where: { saleId },
      select: {
        id: true,
        saleId: true,
        kind: true,
        name: true,
        mime: true,
        driveFileId: true,
        driveFileUrl: true,
      },
    });

    const needIds = docs
      .filter((d) => !d.driveFileId || KEEP_BASE64_KINDS.has(d.kind))
      .map((d) => d.id);
    if (!needIds.length) return docs;

    const withData = await this.documents.find({
      where: { id: In(needIds) },
      select: { id: true, dataBase64: true },
    });
    const byId = new Map(withData.map((d) => [d.id, d.dataBase64]));
    for (const d of docs) {
      if (byId.has(d.id)) d.dataBase64 = byId.get(d.id) ?? null;
    }
    return docs;
  }
}
