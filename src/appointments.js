const { randomUUID } = require('node:crypto');
const { classifyResponse, formatAppointmentMessage } = require('./messaging');

function hydrate(db, appointment) {
  const patient = db.patients.find((item) => item.id === appointment.patientId);
  const doctor = db.doctors.find((item) => item.id === appointment.doctorId);
  const clinic = db.clinics.find((item) => item.id === appointment.clinicId);
  return { ...appointment, patient, doctor, clinic };
}

class AppointmentService {
  constructor(store, messaging) {
    this.store = store;
    this.messaging = messaging;
  }

  listAppointments() {
    const db = this.store.read();
    return db.appointments.map((appointment) => hydrate(db, appointment));
  }

  createAppointment(input) {
    const required = ['clinicId', 'patientId', 'doctorId', 'startsAt'];
    for (const field of required) {
      if (!input[field]) throw new Error(`Falta el campo obligatorio: ${field}`);
    }
    const appointment = {
      id: randomUUID(),
      clinicId: input.clinicId,
      patientId: input.patientId,
      doctorId: input.doctorId,
      startsAt: new Date(input.startsAt).toISOString(),
      status: 'pending',
      channel: input.channel || 'whatsapp',
      lastReminderHours: null
    };
    this.store.update((db) => db.appointments.push(appointment));
    this.store.addAudit('appointment_created', appointment.id, { startsAt: appointment.startsAt });
    this.sendAppointmentRequest(appointment.id);
    return appointment;
  }

  sendAppointmentRequest(appointmentId, kind = 'confirmation_request') {
    const db = this.store.read();
    const appointment = db.appointments.find((item) => item.id === appointmentId);
    if (!appointment) throw new Error('Turno no encontrado');
    const context = hydrate(db, appointment);
    const body = formatAppointmentMessage({ appointment, patient: context.patient, doctor: context.doctor, clinic: context.clinic });
    const sent = this.messaging.send({ channel: appointment.channel, to: context.patient.phone, body, kind, metadata: { appointmentId } });
    this.store.addAudit(kind, appointmentId, { messageId: sent.id, channel: appointment.channel });
    return sent;
  }

  processPatientResponse({ from, body, appointmentId }) {
    const decision = classifyResponse(body);
    return this.store.update((db) => {
      db.inboundMessages.unshift({ id: randomUUID(), from, body, appointmentId, decision, createdAt: new Date().toISOString() });
      const appointment = appointmentId
        ? db.appointments.find((item) => item.id === appointmentId)
        : db.appointments.find((item) => item.status === 'pending' && db.patients.find((patient) => patient.id === item.patientId)?.phone === from);

      if (!appointment) return { decision, status: 'not_found', message: 'No encontramos un turno pendiente asociado a este número.' };
      if (!['pending', 'invalid_response'].includes(appointment.status)) {
        return { decision, status: appointment.status, message: 'El turno ya fue procesado previamente.' };
      }

      if (decision === 'yes') {
        appointment.status = 'confirmed';
        appointment.confirmedAt = new Date().toISOString();
        db.auditLog.unshift(audit('appointment_confirmed', appointment.id, { from }));
        return { decision, status: appointment.status, message: 'Turno confirmado.' };
      }

      if (decision === 'no') {
        appointment.status = 'cancelled';
        appointment.cancelledAt = new Date().toISOString();
        db.auditLog.unshift(audit('appointment_cancelled', appointment.id, { from }));
        const doctor = db.doctors.find((item) => item.id === appointment.doctorId);
        const starts = new Date(appointment.startsAt);
        const date = new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeZone: 'America/Argentina/Buenos_Aires' }).format(starts);
        const time = new Intl.DateTimeFormat('es-AR', { timeStyle: 'short', timeZone: 'America/Argentina/Buenos_Aires' }).format(starts);
        db.outboundMessages.unshift({
          id: randomUUID(), channel: 'email', to: doctor.email,
          body: `Se ha cancelado el turno de ${date} a las ${time}.`, kind: 'doctor_cancellation_notice',
          metadata: { appointmentId: appointment.id }, status: 'sent', createdAt: new Date().toISOString()
        });
        return { decision, status: appointment.status, message: 'Turno cancelado y liberado.' };
      }

      appointment.status = 'invalid_response';
      db.auditLog.unshift(audit('invalid_patient_response', appointment.id, { from, body }));
      return { decision, status: appointment.status, message: 'Respuesta inválida. Respondé Sí para confirmar o No para cancelar.' };
    });
  }

  sendDueReminders(now = new Date()) {
    const reminders = [];
    const db = this.store.read();
    for (const appointment of db.appointments.filter((item) => ['pending', 'invalid_response'].includes(item.status))) {
      const hours = Math.round((new Date(appointment.startsAt) - now) / 36e5);
      const target = hours <= 24 ? 24 : hours <= 48 ? 48 : null;
      if (target && appointment.lastReminderHours !== target && hours > 0) {
        reminders.push(this.sendAppointmentRequest(appointment.id, `reminder_${target}h`));
        this.store.update((fresh) => {
          const current = fresh.appointments.find((item) => item.id === appointment.id);
          current.lastReminderHours = target;
        });
      }
    }
    return reminders;
  }
}

function audit(type, appointmentId, details) {
  return { id: randomUUID(), type, appointmentId, details, createdAt: new Date().toISOString() };
}

module.exports = { AppointmentService, hydrate };
