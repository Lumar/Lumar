const { randomUUID } = require('node:crypto');

const YES_WORDS = new Set(['si', 'sí', 's', 'yes', 'y', 'confirmo', 'confirmar', '1']);
const NO_WORDS = new Set(['no', 'n', 'cancelar', 'cancelo', '2']);

function normalizeResponse(text = '') {
  return text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function classifyResponse(text) {
  const normalized = normalizeResponse(text);
  if (YES_WORDS.has(normalized)) return 'yes';
  if (NO_WORDS.has(normalized)) return 'no';
  return 'invalid';
}

function formatAppointmentMessage({ appointment, patient, doctor, clinic }) {
  const starts = new Date(appointment.startsAt);
  const date = new Intl.DateTimeFormat('es-AR', { dateStyle: 'full', timeZone: 'America/Argentina/Buenos_Aires' }).format(starts);
  const time = new Intl.DateTimeFormat('es-AR', { timeStyle: 'short', timeZone: 'America/Argentina/Buenos_Aires' }).format(starts);
  return `Hola ${patient.name}. Te recordamos tu turno en ${clinic.name}: ${date} a las ${time} con ${doctor.name} (${doctor.specialty}). Respondé Sí para confirmar o No para cancelar.`;
}

class MockMessagingProvider {
  constructor(store) {
    this.store = store;
  }

  send({ channel = 'whatsapp', to, body, kind = 'message', metadata = {} }) {
    return this.store.update((db) => {
      const message = { id: randomUUID(), channel, to, body, kind, metadata, status: 'sent', createdAt: new Date().toISOString() };
      db.outboundMessages.unshift(message);
      return message;
    });
  }
}

module.exports = { classifyResponse, formatAppointmentMessage, MockMessagingProvider };
