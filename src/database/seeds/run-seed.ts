/**
 * Semilla ejecutable:
 *   npm run seed
 *
 * Crea permisos del catálogo y el ADMIN inicial si no existen.
 */
import 'dotenv/config';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../../modules/users/entities/user.entity';
import { Permission } from '../../modules/users/entities/permission.entity';
import { UserPermission } from '../../modules/users/entities/user-permission.entity';
import { RefreshToken } from '../../modules/users/entities/refresh-token.entity';
import { UserType } from '../../common/enums/user-type.enum';
import {
  DEFAULT_ADMIN_PERMISSIONS,
  PERMISSION_CATALOG,
} from '../../common/constants/permissions.constants';
import { postgresSsl } from '../postgres-ssl';

async function run() {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USR,
    password: process.env.DB_PSW,
    database: process.env.DB_NAME,
    ssl: postgresSsl(process.env.DB_HOST, process.env.DB_SSL),
    entities: [User, Permission, UserPermission, RefreshToken],
    synchronize: process.env.DB_SYNC === 'true',
  });

  await ds.initialize();
  console.log('Conexión DB OK');

  const permissionsRepo = ds.getRepository(Permission);
  const usersRepo = ds.getRepository(User);
  const userPermissionsRepo = ds.getRepository(UserPermission);

  let permissionsCreated = 0;
  for (const item of PERMISSION_CATALOG) {
    const exists = await permissionsRepo.findOne({ where: { code: item.code } });
    if (!exists) {
      await permissionsRepo.save(
        permissionsRepo.create({
          code: item.code,
          name: item.name,
          description: item.description,
        }),
      );
      permissionsCreated += 1;
      console.log(`  + permiso: ${item.code}`);
    } else {
      console.log(`  = permiso ya existe: ${item.code}`);
    }
  }

  const adminUsername = process.env.ADMIN_USERNAME ?? 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'AdminVd2026!';
  const adminName =
    process.env.ADMIN_NAME ?? 'Administrador Venta Digital';

  let admin = await usersRepo.findOne({
    where: { username: adminUsername },
    relations: { userPermissions: { permission: true } },
  });

  const forceReset = process.argv.includes('--reset-admin');

  if (!admin) {
    admin = await usersRepo.save(
      usersRepo.create({
        type: UserType.ADMIN,
        fullName: adminName,
        username: adminUsername,
        cellphone: null,
        passwordHash: await bcrypt.hash(adminPassword, 10),
        active: true,
      }),
    );

    const permissions = await permissionsRepo.find();
    const byCode = new Map(permissions.map((p) => [p.code, p]));

    for (const code of DEFAULT_ADMIN_PERMISSIONS) {
      const permission = byCode.get(code);
      if (!permission) continue;
      await userPermissionsRepo.save(
        userPermissionsRepo.create({ user: admin, permission }),
      );
    }

    console.log(`  + admin creado: ${adminUsername}`);
  } else if (forceReset) {
    admin.passwordHash = await bcrypt.hash(adminPassword, 10);
    admin.active = true;
    admin.fullName = adminName;
    await usersRepo.save(admin);
    console.log(`  ~ admin password reseteado: ${adminUsername} (id=${admin.id})`);
  } else {
    console.log(`  = admin ya existe: ${adminUsername} (id=${admin.id})`);
  }

  const totalUsers = await usersRepo.count();
  const totalPermissions = await permissionsRepo.count();

  console.log('');
  console.log('Semilla terminada');
  console.log(`  permisos nuevos: ${permissionsCreated}`);
  console.log(`  permisos totales: ${totalPermissions}`);
  console.log(`  usuarios totales: ${totalUsers}`);
  console.log(`  login admin: ${adminUsername} / (ver .env ADMIN_PASSWORD)`);

  await ds.destroy();
}

run().catch((error) => {
  console.error('Error al ejecutar semilla:', error);
  process.exit(1);
});
