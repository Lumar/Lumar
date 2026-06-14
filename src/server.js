const http = require('node:http');
const { JsonStore } = require('./store');
const { MockMessagingProvider } = require('./messaging');
const { AppointmentService } = require('./appointments');

const store = new JsonStore(process.env.DB_PATH);
const service = new AppointmentService(store, new MockMessagingProvider(store));

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(data, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function renderAdmin() {
  const db = store.read();
  const rows = service.listAppointments().map((apt) => `
    <tr>
      <td>${apt.clinic.name}</td><td>${apt.patient.name}<br><small>${apt.patient.phone}</small></td>
      <td>${apt.doctor.name}<br><small>${apt.doctor.specialty}</small></td>
      <td>${new Date(apt.startsAt).toLocaleString('es-AR')}</td><td><span class="${apt.status}">${apt.status}</span></td>
    </tr>`).join('');
  const messages = db.outboundMessages.slice(0, 8).map((msg) => `<li><strong>${msg.kind}</strong> vía ${msg.channel} a ${msg.to}: ${msg.body}</li>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirmación de turnos</title>
  <style>body{font-family:system-ui;margin:2rem;background:#f7f8fb;color:#172033}main{max-width:1100px;margin:auto}.card{background:white;border-radius:16px;padding:1.25rem;margin:1rem 0;box-shadow:0 8px 30px #17203314}table{width:100%;border-collapse:collapse}td,th{padding:.8rem;border-bottom:1px solid #e7eaf0;text-align:left}.confirmed{color:#087f5b}.cancelled{color:#c92a2a}.pending,.invalid_response{color:#e67700}code{background:#eef2ff;padding:.15rem .3rem;border-radius:5px}</style></head>
  <body><main><h1>Panel de confirmación automática de turnos</h1><p>Canales soportados por diseño: WhatsApp, SMS, push y email mediante proveedores intercambiables. El proveedor actual es mock para desarrollo.</p>
  <section class="card"><h2>Turnos</h2><table><thead><tr><th>Clínica</th><th>Paciente</th><th>Médico</th><th>Fecha y hora</th><th>Estado</th></tr></thead><tbody>${rows}</tbody></table></section>
  <section class="card"><h2>Mensajes recientes</h2><ul>${messages}</ul></section>
  <section class="card"><h2>Webhook de respuesta</h2><p>POST <code>/api/webhooks/patient-response</code> con <code>{"from":"+5491111111111","body":"Sí","appointmentId":"apt-1"}</code>.</p></section>
  </main></body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderAdmin());
    }
    if (req.method === 'GET' && req.url === '/api/appointments') return sendJson(res, 200, service.listAppointments());
    if (req.method === 'GET' && req.url === '/api/audit-log') return sendJson(res, 200, store.read().auditLog);
    if (req.method === 'POST' && req.url === '/api/appointments') return sendJson(res, 201, service.createAppointment(await readBody(req)));
    if (req.method === 'POST' && req.url === '/api/reminders/run') return sendJson(res, 200, { sent: service.sendDueReminders().length });
    if (req.method === 'POST' && req.url === '/api/webhooks/patient-response') return sendJson(res, 200, service.processPatientResponse(await readBody(req)));
    sendJson(res, 404, { error: 'Ruta no encontrada' });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`Servidor listo en http://localhost:${port}`));
}

module.exports = { server, service, store };
