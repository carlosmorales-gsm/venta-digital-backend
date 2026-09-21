import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserType } from '../../../common/enums/user-type.enum';
import { UserPermission } from './user-permission.entity';

/**
 * Usuario del sistema Venta Digital (BD propia).
 *
 * - VENDEDOR: se autentica con celular + PIN WhatsApp (sin password).
 * - MONITOR / ADMIN: se autentican con usuario + contraseña (bcrypt).
 *
 * Todas las fechas se guardan en UTC (Date de TypeORM / PostgreSQL timestamptz).
 */
@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 20 })
  type: UserType;

  @Column({ name: 'full_name', type: 'varchar', length: 150 })
  fullName: string;

  /**
   * Celular WhatsApp a 10 dígitos. Obligatorio para VENDEDOR.
   * Unique en BD: no puede repetirse entre vendedores.
   */
  @Column({ type: 'varchar', length: 10, nullable: true, unique: true })
  cellphone: string | null;

  /** Usuario de login. Obligatorio para MONITOR y ADMIN. */
  @Column({ type: 'varchar', length: 80, nullable: true, unique: true })
  username: string | null;

  /** Hash bcrypt. Null en vendedores. */
  @Column({ name: 'password_hash', type: 'varchar', length: 255, nullable: true })
  passwordHash: string | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  /** MONITOR/ADMIN: al iniciar sesión debe capturar una contraseña nueva. */
  @Column({ name: 'must_change_password', type: 'boolean', default: false })
  mustChangePassword!: boolean;

  /** Nombre del jefe de ventas. Solo aplica a VENDEDOR; va a la carátula. */
  @Column({
    name: 'nombre_jefe_ventas',
    type: 'varchar',
    length: 120,
    nullable: true,
  })
  nombreJefeVentas: string | null;

  @OneToMany(() => UserPermission, (up) => up.user, { cascade: true })
  userPermissions: UserPermission[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
