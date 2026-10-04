import type { Db } from '../db'
import { EventRepo } from './events'
import { JobRepo } from './jobs'
import { MiscRepo } from './misc'
import { VaultRepo } from './obsidian'
import { ProjectRepo } from './projects'
import { ProviderRepo } from './providers'
import { WorkerRepo } from './workers'

/** Single injection point for every repository. */
export class Repos {
  readonly projects: ProjectRepo
  readonly providers: ProviderRepo
  readonly jobs: JobRepo
  readonly workers: WorkerRepo
  readonly events: EventRepo
  readonly vaults: VaultRepo
  readonly misc: MiscRepo

  constructor(readonly db: Db) {
    this.projects = new ProjectRepo(db)
    this.providers = new ProviderRepo(db)
    this.jobs = new JobRepo(db)
    this.workers = new WorkerRepo(db)
    this.events = new EventRepo(db)
    this.vaults = new VaultRepo(db)
    this.misc = new MiscRepo(db)
  }

  close(): void {
    this.db.close()
  }
}

export { ProjectRepo } from './projects'
export { ProviderRepo } from './providers'
export { JobRepo, type JobPlan } from './jobs'
export { WorkerRepo } from './workers'
export { EventRepo } from './events'
export { VaultRepo, toFtsQuery } from './obsidian'
export { MiscRepo, type Template, type Notification } from './misc'
