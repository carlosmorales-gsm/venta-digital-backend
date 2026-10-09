import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Sale } from './sale.entity';

/** Titular (res.partner en Odoo): datos personales + domicilio. */
@Entity({ name: 'sale_holders' })
export class SaleHolder {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'sale_id', type: 'int', unique: true })
  saleId!: number;

  @OneToOne(() => Sale, (s) => s.holder, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sale_id' })
  sale!: Sale;

  @Column({ name: 'apellido_paterno', type: 'varchar', length: 80, default: '' })
  apellidoPaterno!: string;

  @Column({ name: 'apellido_materno', type: 'varchar', length: 80, default: '' })
  apellidoMaterno!: string;

  @Column({ type: 'varchar', length: 120, default: '' })
  nombres!: string;

  @Column({ type: 'varchar', length: 10, default: '' })
  sexo!: string;

  @Column({ type: 'varchar', length: 18, default: '' })
  curp!: string;

  @Column({ type: 'varchar', length: 10, default: '' })
  factura!: string;

  @Column({ name: 'tipo_persona', type: 'varchar', length: 10, default: '' })
  tipoPersona!: string;

  @Column({ name: 'razon_social', type: 'varchar', length: 200, default: '' })
  razonSocial!: string;

  @Column({ type: 'varchar', length: 13, default: '' })
  rfc!: string;

  @Column({ name: 'factura_cp', type: 'varchar', length: 10, default: '' })
  facturaCp!: string;

  @Column({ name: 'misma_direccion_factura', type: 'varchar', length: 10, default: '' })
  mismaDireccionFactura!: string;

  @Column({ name: 'factura_direccion', type: 'varchar', length: 220, default: '' })
  facturaDireccion!: string;

  @Column({ name: 'factura_colonia', type: 'varchar', length: 120, default: '' })
  facturaColonia!: string;

  @Column({ name: 'factura_municipio', type: 'varchar', length: 120, default: '' })
  facturaMunicipio!: string;

  @Column({ name: 'factura_estado', type: 'varchar', length: 80, default: '' })
  facturaEstado!: string;

  @Column({ name: 'factura_pais', type: 'varchar', length: 80, default: '' })
  facturaPais!: string;

  @Column({ name: 'regimen_fiscal', type: 'varchar', length: 10, default: '' })
  regimenFiscal!: string;

  @Column({ name: 'regimen_fiscal_otro', type: 'varchar', length: 120, default: '' })
  regimenFiscalOtro!: string;

  @Column({ name: 'telefono_factura', type: 'varchar', length: 20, default: '' })
  telefonoFactura!: string;

  @Column({ name: 'fecha_nacimiento', type: 'date', nullable: true })
  fechaNacimiento!: string | null;

  @Column({ name: 'estado_civil', type: 'varchar', length: 40, default: '' })
  estadoCivil!: string;

  @Column({ type: 'varchar', length: 10, default: '' })
  sindicalizado!: string;

  @Column({ type: 'text', default: '' })
  observaciones!: string;

  @Column({ type: 'varchar', length: 20, default: '' })
  celular1!: string;

  @Column({ type: 'varchar', length: 20, default: '' })
  celular2!: string;

  @Column({ type: 'varchar', length: 180, default: '' })
  correo!: string;

  @Column({ type: 'varchar', length: 220, default: '' })
  direccion!: string;

  @Column({ type: 'varchar', length: 120, default: '' })
  colonia!: string;

  @Column({ type: 'varchar', length: 10, default: '' })
  cp!: string;

  @Column({ name: 'entre_calles', type: 'varchar', length: 220, default: '' })
  entreCalles!: string;

  @Column({ name: 'sena_particular', type: 'varchar', length: 220, default: '' })
  senaParticular!: string;

  @Column({ type: 'varchar', length: 120, default: '' })
  municipio!: string;

  @Column({ type: 'varchar', length: 80, default: '' })
  estado!: string;

  @Column({ name: 'tipo_cobranza', type: 'varchar', length: 40, default: '' })
  tipoCobranza!: string;

  @Column({
    name: 'domicilio_entrega_documentacion',
    type: 'varchar',
    length: 220,
    default: '',
  })
  domicilioEntregaDocumentacion!: string;
}
