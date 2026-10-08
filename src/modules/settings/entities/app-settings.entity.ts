import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Configuración global (una sola fila, id = 1). */
@Entity({ name: 'app_settings' })
export class AppSettings {
  @PrimaryColumn({ type: 'int' })
  id!: number;

  /** Máximo de borradores activos por vendedor. */
  @Column({ name: 'draft_limit', type: 'int', default: 3 })
  draftLimit!: number;

  /** Horas de vigencia de un borrador desde el último guardado. */
  @Column({ name: 'draft_ttl_hours', type: 'int', default: 24 })
  draftTtlHours!: number;

  /** Porcentaje máximo de descuento (0–100) que puede aplicar un vendedor (salvo especial). */
  @Column({
    name: 'max_discount_amount',
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0,
  })
  maxDiscountAmount!: string;

  /** Si está activo, los vendedores entran con la contraseña definida aquí. */
  @Column({ name: 'seller_password_login', type: 'boolean', default: false })
  sellerPasswordLogin!: boolean;

  /** Hash bcrypt de la contraseña compartida de vendedores. Nunca se expone. */
  @Column({ name: 'seller_access_password_hash', type: 'text', nullable: true })
  sellerAccessPasswordHash!: string | null;

  /**
   * Fin de vigencia (exclusivo). La contraseña vale hasta el final
   * del día siguiente al que se definió, en la zona de negocio.
   */
  @Column({
    name: 'seller_access_password_expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  sellerAccessPasswordExpiresAt!: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
