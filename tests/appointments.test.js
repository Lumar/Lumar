const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore, DEFAULT_DB } = require('../src/store');
const { MockMessagingProvider, classifyResponse } = require('../src/messaging');
const { AppointmentService } = require('../src/appointments');

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turnos-'));
  const file = path.join(dir, 'db.json');
  fs.writeFileSync(file, JSON.stringify(DEFAULT_DB, null, 2));
  const store = new JsonStore(file);
  return { store, service: new AppointmentService(store, new MockMessagingProvider(store)) };
}

test('clasifica respuestas afirmativas, negativas e inválidas', () => {
  assert.equal(classifyResponse('Sí'), 'yes');
  assert.equal(classifyResponse('No'), 'no');
  assert.equal(classifyResponse('tal vez'), 'invalid');
});

test('confirma un turno cuando el paciente responde sí', () => {
  const { store, service } = makeService();
  const result = service.processPatientResponse({ from: '+5491111111111', body: 'Sí', appointmentId: 'apt-1' });
  assert.equal(result.status, 'confirmed');
  assert.equal(store.read().appointments.find((item) => item.id === 'apt-1').status, 'confirmed');
});

test('cancela y notifica al médico cuando el paciente responde no', () => {
  const { store, service } = makeService();
  const result = service.processPatientResponse({ from: '+5491111111111', body: 'No', appointmentId: 'apt-1' });
  const db = store.read();
  assert.equal(result.status, 'cancelled');
  assert.equal(db.appointments.find((item) => item.id === 'apt-1').status, 'cancelled');
  assert.equal(db.outboundMessages[0].kind, 'doctor_cancellation_notice');
});

test('marca respuesta inválida y pide una respuesta válida', () => {
  const { store, service } = makeService();
  const result = service.processPatientResponse({ from: '+5491111111111', body: 'quizás', appointmentId: 'apt-1' });
  assert.equal(result.decision, 'invalid');
  assert.equal(store.read().appointments.find((item) => item.id === 'apt-1').status, 'invalid_response');
});

test('envía recordatorios pendientes de 48h y 24h una sola vez por ventana', () => {
  const { service } = makeService();
  assert.equal(service.sendDueReminders().length, 2);
  assert.equal(service.sendDueReminders().length, 0);
});
