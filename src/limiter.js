// 进程级 FIFO 信号量：所有 Telegram update 共享同一媒体并发上限。
export class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, Math.floor(Number(limit) || 1));
    this.active = 0;
    this.waiters = [];
  }

  async run(task) {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  acquire() {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.waiters.push(resolve));
  }

  release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  stats() {
    return { active: this.active, queued: this.waiters.length, limit: this.limit };
  }
}
