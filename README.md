# Confirmación automática de turnos médicos

Aplicación Node.js sin dependencias externas para confirmar, cancelar y auditar turnos médicos mediante mensajes al celular. Incluye un panel administrativo simple y una API lista para conectar proveedores reales de WhatsApp, SMS, push o email.

## Tecnología sugerida

Para un MVP robusto conviene empezar con:

- **Backend:** Node.js con API HTTP modular.
- **Persistencia:** JSON local para demo; PostgreSQL recomendado en producción.
- **Mensajería:** proveedor intercambiable. La demo usa `MockMessagingProvider`; en producción se puede reemplazar por Twilio, WhatsApp Cloud API, Vonage, Firebase Cloud Messaging o SendGrid.
- **Panel administrativo:** HTML server-side simple para ver estado de turnos, mensajes y auditoría.

## Funcionalidades

- Envío de solicitud de confirmación con fecha, hora, médico y especialidad.
- Respuestas simples: `Sí` confirma; `No` cancela y libera el turno.
- Notificación automática al médico cuando el paciente cancela.
- Manejo de respuestas inválidas y múltiples respuestas.
- Recordatorios automáticos de 48h y 24h.
- Registro de auditoría de altas, confirmaciones, cancelaciones, recordatorios y respuestas inválidas.
- Soporte multi-clínica y multi-médico desde el modelo de datos.
- Panel administrativo en `/`.

## Uso

```bash
npm start
```

Abrir `http://localhost:3000`.

### API principal

- `GET /api/appointments`: lista turnos enriquecidos con paciente, médico y clínica.
- `POST /api/appointments`: crea un turno y envía la solicitud de confirmación.
- `POST /api/webhooks/patient-response`: procesa una respuesta entrante.
- `POST /api/reminders/run`: envía recordatorios pendientes de 48h/24h.
- `GET /api/audit-log`: consulta el registro de eventos.

Ejemplo de respuesta entrante:

```bash
curl -X POST http://localhost:3000/api/webhooks/patient-response \
  -H 'content-type: application/json' \
  -d '{"from":"+5491111111111","body":"Sí","appointmentId":"apt-1"}'
```

## Próximos pasos de producción

1. Migrar `JsonStore` a PostgreSQL con transacciones.
2. Conectar WhatsApp Cloud API o Twilio y validar firmas de webhooks.
3. Agregar autenticación al panel administrativo.
4. Ejecutar recordatorios con cron, queue o scheduler administrado.
5. Integrar con el sistema de agenda existente mediante API o sincronización de base de datos.
