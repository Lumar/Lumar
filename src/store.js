const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_DB = {
  clinics: [{ id: 'clinic-1', name: 'Clínica Centro' }],
  doctors: [
    { id: 'doc-1', clinicId: 'clinic-1', name: 'Dra. Laura Pérez', specialty: 'Cardiología', phone: '+5491100000001', email: 'laura.perez@example.com' },
    { id: 'doc-2', clinicId: 'clinic-1', name: 'Dr. Martín Gómez', specialty: 'Dermatología', phone: '+5491100000002', email: 'martin.gomez@example.com' }
  ],
  patients: [
    { id: 'pat-1', clinicId: 'clinic-1', name: 'Ana Torres', phone: '+5491111111111' },
    { id: 'pat-2', clinicId: 'clinic-1', name: 'Carlos Ruiz', phone: '+5491122222222' }
  ],
  appointments: [
    { id: 'apt-1', clinicId: 'clinic-1', patientId: 'pat-1', doctorId: 'doc-1', startsAt: futureIso(47), status: 'pending', channel: 'whatsapp', lastReminderHours: null },
    { id: 'apt-2', clinicId: 'clinic-1', patientId: 'pat-2', doctorId: 'doc-2', startsAt: futureIso(25), status: 'pending', channel: 'sms', lastReminderHours: null }
  ],
  auditLog: [],
  outboundMessages: [],
  inboundMessages: []
};

function futureIso(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

class JsonStore {
  constructor(filePath = path.join(__dirname, '..', 'data', 'db.json')) {
    this.filePath = filePath;
    this.ensure();
  }

  ensure() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify(DEFAULT_DB, null, 2));
    }
  }

  read() {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  write(db) {
    fs.writeFileSync(this.filePath, JSON.stringify(db, null, 2));
    return db;
  }

  update(mutator) {
    const db = this.read();
    const result = mutator(db);
    this.write(db);
    return result;
  }

  addAudit(type, appointmentId, details = {}) {
    return this.update((db) => {
      const entry = { id: randomUUID(), type, appointmentId, details, createdAt: new Date().toISOString() };
      db.auditLog.unshift(entry);
      return entry;
    });
  }
}

module.exports = { JsonStore, DEFAULT_DB };
