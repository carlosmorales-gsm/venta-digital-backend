import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { UserType } from '../../../common/enums/user-type.enum';

function usernameKey(username: string): string {
  return username.trim().toUpperCase();
}

/** Consultas a `users`. Sin lógica de negocio. */
@Injectable()
export class UsersRepository {
  constructor(
    @InjectRepository(User)
    private readonly repo: Repository<User>,
  ) {}

  findByIdWithPermissions(id: number): Promise<User | null> {
    return this.repo.findOne({
      where: { id },
      relations: { userPermissions: { permission: true } },
    });
  }

  findActiveByIdWithPermissions(id: number): Promise<User | null> {
    return this.repo.findOne({
      where: { id, active: true },
      relations: { userPermissions: { permission: true } },
    });
  }

  findById(id: number): Promise<User | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByCellphone(cellphone: string): Promise<User | null> {
    return this.repo.findOne({ where: { cellphone } });
  }

  /** Celular de WhatsApp ya usado por un vendedor (activo o no). */
  findSellerByCellphone(cellphone: string): Promise<User | null> {
    return this.repo.findOne({
      where: { cellphone, type: UserType.VENDEDOR },
    });
  }

  async findSellerByCellphoneExcludingId(
    cellphone: string,
    excludeId: number,
  ): Promise<User | null> {
    const user = await this.findSellerByCellphone(cellphone);
    if (user && user.id !== excludeId) return user;
    return null;
  }

  /** Pasa a mayúsculas los username que ya estaban guardados en minúsculas. */
  uppercaseExistingUsernames() {
    return this.repo
      .createQueryBuilder()
      .update(User)
      .set({ username: () => 'UPPER(username)' })
      .where('username IS NOT NULL')
      .andWhere('username <> UPPER(username)')
      .execute();
  }

  findByUsername(username: string): Promise<User | null> {
    return this.repo
      .createQueryBuilder('user')
      .where('UPPER(user.username) = :username', {
        username: usernameKey(username),
      })
      .getOne();
  }

  /** Otro usuario con el mismo celular (para ediciones). */
  async findByCellphoneExcludingId(
    cellphone: string,
    excludeId: number,
  ): Promise<User | null> {
    const user = await this.findByCellphone(cellphone);
    if (user && user.id !== excludeId) return user;
    return null;
  }

  /** Otro usuario con el mismo username (para ediciones). */
  async findByUsernameExcludingId(
    username: string,
    excludeId: number,
  ): Promise<User | null> {
    const user = await this.findByUsername(username);
    if (user && user.id !== excludeId) return user;
    return null;
  }

  countActiveAdmins(): Promise<number> {
    return this.repo.count({
      where: { type: UserType.ADMIN, active: true },
    });
  }

  save(user: User): Promise<User> {
    return this.repo.save(user);
  }

  findActiveSellerByCellphone(cellphone: string): Promise<User | null> {
    return this.repo.findOne({
      where: {
        cellphone,
        type: UserType.VENDEDOR,
        active: true,
      },
    });
  }

  findActiveSellerByCellphoneWithPermissions(
    cellphone: string,
  ): Promise<User | null> {
    return this.repo.findOne({
      where: {
        cellphone,
        type: UserType.VENDEDOR,
        active: true,
      },
      relations: { userPermissions: { permission: true } },
    });
  }

  findActiveByUsernameWithPermissions(
    username: string,
  ): Promise<User | null> {
    return this.repo
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.userPermissions', 'userPermissions')
      .leftJoinAndSelect('userPermissions.permission', 'permission')
      .where('UPPER(user.username) = :username', {
        username: usernameKey(username),
      })
      .andWhere('user.active = :active', { active: true })
      .getOne();
  }

  list(type?: UserType): Promise<User[]> {
    return this.repo.find({
      where: type ? { type } : {},
      relations: { userPermissions: { permission: true } },
      order: { id: 'ASC' },
    });
  }

  countByType(type: UserType): Promise<number> {
    return this.repo.count({ where: { type } });
  }

  createAndSave(data: Partial<User>): Promise<User> {
    return this.repo.save(this.repo.create(data));
  }
}
