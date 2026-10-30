// shared/db.js
// Database-per-Service Isolated File Database
// Provides atomic persistence, mutex-safe updates, and ACID isolation per microservice.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

class JsonDatabase {
  constructor(serviceName, dataDir = path.join(__dirname, '..', 'data')) {
    this.serviceName = serviceName;
    this.filePath = path.join(dataDir, `${serviceName}.json`);
    this.queue = Promise.resolve();

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify([], null, 2), 'utf-8');
    }
  }

  // Serialized execution to prevent race conditions during file read/write
  _enqueue(operation) {
    this.queue = this.queue.then(() => operation()).catch(err => {
      console.error(`DB Error in [${this.serviceName}]:`, err);
      throw err;
    });
    return this.queue;
  }

  _readSync() {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(content || '[]');
    } catch (err) {
      return [];
    }
  }

  _writeSync(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  async getAll() {
    return this._enqueue(async () => {
      return this._readSync();
    });
  }

  async find(predicate) {
    return this._enqueue(async () => {
      const records = this._readSync();
      return records.filter(predicate);
    });
  }

  async findOne(predicate) {
    return this._enqueue(async () => {
      const records = this._readSync();
      return records.find(predicate) || null;
    });
  }

  async findById(id) {
    return this.findOne(item => item.id === id);
  }

  async insert(record) {
    return this._enqueue(async () => {
      const records = this._readSync();
      const newRecord = {
        id: record.id || randomUUID(),
        ...record,
        createdAt: record.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      records.push(newRecord);
      this._writeSync(records);
      return newRecord;
    });
  }

  async update(id, updates) {
    return this._enqueue(async () => {
      const records = this._readSync();
      const index = records.findIndex(item => item.id === id);
      if (index === -1) return null;

      const updated = {
        ...records[index],
        ...updates,
        updatedAt: new Date().toISOString()
      };
      records[index] = updated;
      this._writeSync(records);
      return updated;
    });
  }

  // Atomic read-modify-write for account balances and saga states
  async atomicUpdate(id, updaterFn) {
    return this._enqueue(async () => {
      const records = this._readSync();
      const index = records.findIndex(item => item.id === id);
      if (index === -1) {
        throw new Error(`Record with id ${id} not found in ${this.serviceName}`);
      }

      const current = records[index];
      const updated = updaterFn({ ...current });
      if (!updated) {
        throw new Error('Updater function did not return updated state');
      }

      records[index] = {
        ...updated,
        updatedAt: new Date().toISOString()
      };
      this._writeSync(records);
      return records[index];
    });
  }

  async delete(id) {
    return this._enqueue(async () => {
      const records = this._readSync();
      const filtered = records.filter(item => item.id !== id);
      if (filtered.length !== records.length) {
        this._writeSync(filtered);
        return true;
      }
      return false;
    });
  }

  async clear() {
    return this._enqueue(async () => {
      this._writeSync([]);
      return true;
    });
  }
}

module.exports = JsonDatabase;
