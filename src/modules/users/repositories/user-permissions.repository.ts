import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserPermission } from '../entities/user-permission.entity';
import { User } from '../entities/user.entity';
import { Permission } from '../entities/permission.entity';

/** Consultas a `user_permissions`. Sin lógica de negocio. */
@Injectable()
export class UserPermissionsRepository {
  constructor(
    @InjectRepository(UserPermission)
    private readonly repo: Repository<UserPermission>,
  ) {}

  assign(user: User, permission: Permission): Promise<UserPermission> {
    return this.repo.save(this.repo.create({ user, permission }));
  }

  revoke(userId: number, permissionId: number): Promise<void> {
    return this.repo
      .createQueryBuilder()
      .delete()
      .where('user_id = :userId', { userId })
      .andWhere('permission_id = :permissionId', { permissionId })
      .execute()
      .then(() => undefined);
  }
}
