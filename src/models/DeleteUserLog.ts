import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm'

@Entity()
export class DeleteUserLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  tenant_id: string;

  @Column({ type: 'varchar', length: 100 })
  user_id: string;

  @Column({ type: 'varchar', length: 100 })
  email: string;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  delete_at: Date;

  constructor(
    tenant_id: string,
    user_id: string,
    email: string,
    delete_at?: Date
  ) {
    this.tenant_id = tenant_id
    this.user_id = user_id
    this.email = email
    this.delete_at = delete_at || new Date()
  }
}
