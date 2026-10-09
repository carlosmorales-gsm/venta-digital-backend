import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class SaleAttachmentDto {
  @IsString()
  name!: string;

  @IsString()
  mime!: string;

  @IsOptional()
  @IsString()
  dataBase64?: string;

  @IsOptional()
  @IsString()
  driveFileId?: string | null;

  @IsOptional()
  @IsString()
  driveFileUrl?: string | null;
}

export class SalePersonDto {
  @IsOptional() @IsString() apellidoPaterno?: string;
  @IsOptional() @IsString() apellidoMaterno?: string;
  @IsOptional() @IsString() nombres?: string;
}

export class SaleContactoDto extends SalePersonDto {
  @IsOptional() @IsString() sexo?: string;
  @IsOptional() @IsString() curp?: string;
  @IsOptional() @IsString() factura?: string;
  @IsOptional() @IsString() tipoPersona?: string;
  @IsOptional() @IsString() razonSocial?: string;
  @IsOptional() @IsString() rfc?: string;
  @IsOptional() @IsString() facturaCp?: string;
  @IsOptional() @IsString() mismaDireccionFactura?: string;
  @IsOptional() @IsString() facturaDireccion?: string;
  @IsOptional() @IsString() facturaColonia?: string;
  @IsOptional() @IsString() facturaMunicipio?: string;
  @IsOptional() @IsString() facturaEstado?: string;
  @IsOptional() @IsString() facturaPais?: string;
  @IsOptional() @IsString() regimenFiscal?: string;
  @IsOptional() @IsString() regimenFiscalOtro?: string;
  @IsOptional() @IsString() telefonoFactura?: string;
  @IsOptional() @IsString() direccion?: string;
  @IsOptional() @IsString() colonia?: string;
  @IsOptional() @IsString() cp?: string;
  @IsOptional() @IsString() entreCalles?: string;
  @IsOptional() @IsString() senaParticular?: string;
  @IsOptional() @IsString() municipio?: string;
  @IsOptional() @IsString() estado?: string;
  @IsOptional() @IsString() tipoCobranza?: string;
  @IsOptional() @IsString() fechaNacimiento?: string;
  @IsOptional() @IsString() sindicalizado?: string;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsString() celular1?: string;
  @IsOptional() @IsString() celular2?: string;
  @IsOptional() @IsString() correo?: string;
  @IsOptional() @IsString() estadoCivil?: string;
  @IsOptional() @IsString() domicilioEntregaDocumentacion?: string;
}

export class SaleSegundoDto extends SalePersonDto {
  @IsOptional() @IsString() celular?: string;
  @IsOptional() @IsString() parentesco?: string;
  @IsOptional() @Type(() => Number) @IsInt() relationId?: number | null;
  @IsOptional() @IsString() direccion?: string;
  @IsOptional() @IsString() colonia?: string;
  @IsOptional() @IsString() cp?: string;
  @IsOptional() @IsString() entreCalles?: string;
  @IsOptional() @IsString() fechaNacimiento?: string;
  @IsOptional() @IsString() domicilioEntregaDocumentacion?: string;
}

export class SaleBeneficiaryDto extends SalePersonDto {
  @IsOptional() @IsString() parentesco?: string;
  @IsOptional() @Type(() => Number) @IsInt() relationId?: number | null;
  @IsOptional() @IsString() celular?: string;
  @IsOptional() @IsString() fechaNacimiento?: string;
}

export class SaleDerechohabientesDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleBeneficiaryDto)
  titularSustituto?: SaleBeneficiaryDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SaleBeneficiaryDto)
  primerBeneficiario?: SaleBeneficiaryDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SaleBeneficiaryDto)
  segundoBeneficiario?: SaleBeneficiaryDto;
}

export class ReconocimientoVentaDto {
  @IsOptional() @Type(() => Number) @IsInt() id?: number;
  @IsOptional() @IsString() folio?: string;
  @IsOptional() @Type(() => Number) @IsInt() partnerId?: number;
  @IsOptional() @IsString() partnerName?: string;
  @IsOptional() @IsString() dateOrder?: string;
  @IsOptional() @Type(() => Number) amountTotal?: number;
  @IsOptional() @Type(() => Number) saldo?: number;
  @IsOptional() @Type(() => Number) paidAmount?: number;
  @IsOptional() @IsString() matchType?: string;
  @IsOptional() @IsString() matchedBeneficiaryName?: string;
}

export class SaleMetaDto {
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() contrato?: string;
  @IsOptional() @IsString() origenVenta?: string;
  @IsOptional() @Type(() => Number) @IsInt() branchId?: number | null;
  @IsOptional() @IsString() branchName?: string;
  @IsOptional() @Type(() => Number) @IsInt() serviceTypeId?: number | null;
  @IsOptional() @IsString() serviceTypeName?: string;
  @IsOptional() @IsString() folioSolicitud?: string;
  @IsOptional() @IsString() fechaServicio?: string;
  /** NUEVA | RECONOCIMIENTO | MEJORA | MINORIA — define estatus */
  @IsOptional() @IsString() tipoVenta?: string;
  @IsOptional() @IsString() estatus?: string;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReconocimientoVentaDto)
  reconocimientoVentas?: ReconocimientoVentaDto[];
  @IsOptional() @IsString() anterior?: string;
  @IsOptional() @IsString() verificacion?: string;
}

export class SalePlanDto {
  @IsOptional()
  @IsIn(['PARQUE', 'PLAN_FUTURO', ''])
  planKind?: string;

  @IsOptional() @IsString() nombrePlan?: string;
  @IsOptional() @Type(() => Number) @IsInt() productId?: number | null;
  @IsOptional() @IsString() productDefaultCode?: string;
  @IsOptional() @IsString() precioPlan?: string;
  @IsOptional() @IsString() seccion?: string;
  @IsOptional() @IsString() cuadrante?: string;
  @IsOptional() @IsString() numero?: string;
  @IsOptional() @IsString() servicioFunerario?: string;
  @IsOptional() @IsString() parqueFuneral?: string;
  @IsOptional() @Type(() => Number) @IsInt() parkId?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() sectionId?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() quadrantId?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() spaceId?: number | null;
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value == null || value === '') return false;
    const t = String(value).trim().toLowerCase();
    return ['true', '1', 'si', 'sí', 'yes'].includes(t);
  })
  @IsBoolean()
  preasignacion?: boolean;

  /** product.template.without_interest — plan sin intereses (solo UI/cálculo financiero). */
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value == null || value === '') return false;
    const t = String(value).trim().toLowerCase();
    return ['true', '1', 'si', 'sí', 'yes'].includes(t);
  })
  @IsBoolean()
  withoutInterest?: boolean;
}

export class SalePagoDto {
  @IsOptional() @IsString() precioPlan?: string;
  @IsOptional() @IsString() frecuencia?: string;
  @IsOptional() @IsString() promocionDescuento?: string;
  @IsOptional() @IsString() anticipo?: string;
  @IsOptional() @IsString() pagoInicial?: string;
  @IsOptional() @IsString() plazo?: string;
  @IsOptional() @IsString() importeCadaPago?: string;
  @IsOptional() @IsString() saldo?: string;
  @IsOptional() @IsString() fechaProximoPago?: string;
  @IsOptional() @IsString() diasEspecificosPago?: string;
  @IsOptional() @IsString() formaPago?: string;
  @IsOptional() @IsString() cuenta?: string;
  @IsOptional() @IsString() banco?: string;
  @IsOptional() @IsString() cuentaPago?: string;
  @IsOptional() @IsString() bancoPago?: string;
  @IsOptional() @IsString() vencimientoTarjeta?: string;
  @IsOptional() @IsString() titularTarjeta?: string;
  @IsOptional() @IsString() cvv?: string;
  @IsOptional() @IsString() numeroEmpleado?: string;
  @IsOptional() @IsString() nombreEmpleado?: string;
  @IsOptional() @IsString() empresaNomina?: string;
  @IsOptional() @Type(() => Number) @IsInt() empresaNominaId?: number | null;
  @IsOptional() @IsString() infoNomina?: string;
  @IsOptional() @IsString() montoRecibido?: string;
  @IsOptional() @IsString() cambio?: string;
  @IsOptional() @IsString() nombreJefeVentas?: string;
  @IsOptional() @IsString() nombreAsesor?: string;
}

export class SaleMascotaDto {
  @IsOptional() @IsString() @MaxLength(180) name?: string;
  @IsOptional() @IsBoolean() isFinado?: boolean;
  @IsOptional() @IsString() @MaxLength(40) finadoDate?: string;
  @IsOptional() @Type(() => Number) @IsInt() especieId?: number | null;
  @IsOptional() @IsString() @MaxLength(180) especieName?: string;
  @IsOptional() @Type(() => Number) @IsInt() razaId?: number | null;
  @IsOptional() @IsString() @MaxLength(180) razaName?: string;
  @IsOptional() @IsString() @MaxLength(80) color?: string;
  @IsOptional() @IsString() @MaxLength(500) rasgosParticulares?: string;
  @IsOptional() @Type(() => Number) @IsInt() tamanoId?: number | null;
  @IsOptional() @IsString() @MaxLength(80) tamanoName?: string;
  @IsOptional() @IsString() @MaxLength(40) tamanoCode?: string;
  @IsOptional() @IsString() @MaxLength(40) peso?: string;
  @IsOptional() @IsString() @MaxLength(20) genero?: string;
  @IsOptional() @IsString() @MaxLength(40) birthDate?: string;
  @IsOptional() @IsString() @MaxLength(20) lugarDeceso?: string;
  @IsOptional() @IsString() @MaxLength(180) veterinaria?: string;
  @IsOptional() @IsString() @MaxLength(40) deathDatetime?: string;
  @IsOptional() @IsString() @MaxLength(80) microchipId?: string;
  @IsOptional() @IsBoolean() collar?: boolean;
  @IsOptional() @IsBoolean() placaTestigo?: boolean;
  @IsOptional() @IsString() @MaxLength(80) placaTestigoNumero?: string;
  @IsOptional() @IsString() @MaxLength(40) recepcionDatetime?: string;
  @IsOptional() @IsString() @MaxLength(2000) notas?: string;
  @IsOptional() @IsString() @MaxLength(2000) comentarios?: string;
}

export class SaleFormPayloadDto {
  @IsOptional() @ValidateNested() @Type(() => SaleMetaDto) meta?: SaleMetaDto;
  @IsOptional() @ValidateNested() @Type(() => SaleContactoDto) contacto?: SaleContactoDto;
  @IsOptional() @ValidateNested() @Type(() => SaleSegundoDto) segundoContacto?: SaleSegundoDto;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaleBeneficiaryDto)
  beneficiarios?: SaleBeneficiaryDto[];
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleMascotaDto)
  mascota?: SaleMascotaDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleDerechohabientesDto)
  derechohabientes?: SaleDerechohabientesDto;
  @IsOptional() @ValidateNested() @Type(() => SalePlanDto) ubicacionPlan?: SalePlanDto;
  @IsOptional() @ValidateNested() @Type(() => SalePagoDto) pago?: SalePagoDto;
  @IsOptional()
  @IsObject()
  declaraciones?: { aceptaMercadotecnia?: string; aceptaPublicidad?: string };
  @IsOptional()
  @IsObject()
  documentos?: {
    ineFrente?: SaleAttachmentDto | null;
    ineReverso?: SaleAttachmentDto | null;
    inePdf?: SaleAttachmentDto | null;
    /** @deprecated ventas antiguas */
    ine?: SaleAttachmentDto | null;
    comprobanteDomicilio?: SaleAttachmentDto | null;
    constanciaSituacionFiscal?: SaleAttachmentDto | null;
    tarjetaFrente?: SaleAttachmentDto | null;
    tarjetaReverso?: SaleAttachmentDto | null;
    tarjetaPdf?: SaleAttachmentDto | null;
    reciboNomina?: SaleAttachmentDto | null;
    domiciliacionBanorte?: SaleAttachmentDto | null;
    firmaCliente?: SaleAttachmentDto | null;
    ticketPago?: SaleAttachmentDto | null;
    comprobanteTransferencia?: SaleAttachmentDto | null;
  };
}

export class UpsertSaleDto {
  @ValidateNested()
  @Type(() => SaleFormPayloadDto)
  payload!: SaleFormPayloadDto;

  @IsOptional()
  @IsString()
  @MaxLength(220)
  titularName?: string;

  @IsOptional()
  @IsString()
  amount?: string;
}

export class SavePaymentDto {
  @ValidateNested()
  @Type(() => SalePagoDto)
  pago!: SalePagoDto;

  /** Ticket de pago PDF generado en el front. */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleAttachmentDto)
  ticketPdf?: SaleAttachmentDto | null;

  /** Foto o PDF del pago en transferencia o en efectivo. */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleAttachmentDto)
  comprobanteTransferencia?: SaleAttachmentDto | null;
}

export class SignSaleDto {
  @ValidateNested()
  @Type(() => SaleAttachmentDto)
  firmaCliente!: SaleAttachmentDto;

  /** Vista previa / carátula del contrato (PDF generado en el front). */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleAttachmentDto)
  caratulaPdf?: SaleAttachmentDto | null;

  /** Carta de requerimiento de factura (PDF generado en el front). */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleAttachmentDto)
  cartaFacturaPdf?: SaleAttachmentDto | null;

  /** Consentimiento de no factura (PDF generado en el front). */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleAttachmentDto)
  cartaNoFacturaPdf?: SaleAttachmentDto | null;

  /** Carta de aceptación de exclusiones (Anexo A). */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleAttachmentDto)
  cartaExclusionesPdf?: SaleAttachmentDto | null;

  /** Reglamento de parque (carta de reglas). */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleAttachmentDto)
  reglamentoParquePdf?: SaleAttachmentDto | null;

  /** Folleto de artículos del reglamento de parque. */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleAttachmentDto)
  reglamentoParqueFolletoPdf?: SaleAttachmentDto | null;

  /** Carta de autorización de cargo automático (domiciliación). */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleAttachmentDto)
  cartaAutorizacionPdf?: SaleAttachmentDto | null;

  /** Carta de consentimiento / descuento nómina (FO-GEN-SMGF-05). */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleAttachmentDto)
  cartaNominaPdf?: SaleAttachmentDto | null;

  /** PDF de una hoja con frente y reverso de la tarjeta. */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleAttachmentDto)
  tarjetaPdf?: SaleAttachmentDto | null;

  /** PDF de una hoja con frente y reverso de la INE. */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleAttachmentDto)
  inePdf?: SaleAttachmentDto | null;
}
