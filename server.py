import argparse, base64, csv, datetime as dt, hashlib, hmac, io, json, os, secrets, sqlite3, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
DB = ROOT / 'club.db'
CONFIG = ROOT / 'config.json'
STATIC = ROOT / 'index.html'
SESSIONS = {}
LOCK = threading.Lock()

def now():
    return dt.datetime.now().isoformat(timespec='seconds')

def dbconn():
    con = sqlite3.connect(DB, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA busy_timeout=10000')
    con.execute('PRAGMA foreign_keys=ON')
    return con

def initdb():
    with dbconn() as c:
        c.execute('PRAGMA journal_mode=WAL')
        c.executescript('''
        CREATE TABLE IF NOT EXISTS socios(
            id INTEGER PRIMARY KEY,
            nombre TEXT NOT NULL,
            telefono TEXT DEFAULT '',
            creado TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reuniones(
            id INTEGER PRIMARY KEY,
            titulo TEXT NOT NULL,
            fecha TEXT NOT NULL,
            lugar TEXT DEFAULT '',
            descripcion TEXT DEFAULT '',
            creado TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS invitaciones(
            id INTEGER PRIMARY KEY,
            reunion_id INTEGER NOT NULL REFERENCES reuniones(id) ON DELETE CASCADE,
            socio_id INTEGER NOT NULL REFERENCES socios(id) ON DELETE CASCADE,
            token TEXT NOT NULL UNIQUE,
            respuesta TEXT NOT NULL DEFAULT 'pendiente' CHECK(respuesta IN ('pendiente','si','no','quizas')),
            respondido TEXT,
            presente INTEGER NOT NULL DEFAULT 0,
            registrado TEXT,
            UNIQUE(reunion_id, socio_id)
        );
        CREATE INDEX IF NOT EXISTS ix_invitacion_reunion ON invitaciones(reunion_id);
        ''')

def hashpass(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 310000)
    return base64.b64encode(salt).decode() + ':' + base64.b64encode(digest).decode()

def checkpass(password, saved):
    try:
        salt, _ = saved.split(':')
        return hmac.compare_digest(hashpass(password, base64.b64decode(salt)), saved)
    except Exception:
        return False

def setpassword_cli(explicit_pass=None):
    if explicit_pass:
        p1 = explicit_pass
    else:
        import getpass
        p1 = getpass.getpass('Nueva clave de administrador (minimo 10 caracteres): ')
        p2 = getpass.getpass('Repetir clave: ')
        if len(p1) < 10 or p1 != p2:
            raise SystemExit('Las claves no coinciden o son muy cortas.')
    CONFIG.write_text(json.dumps({'password_hash': hashpass(p1)}, indent=2), encoding='utf8')
    print('Clave guardada correctamente.')

class Handler(BaseHTTPRequestHandler):
    server_version = 'ClubAsistencia/1.0'

    def log_message(self, fmt, *args):
        print('[%s] %s' % (self.log_date_time_string(), fmt % args))

    def respond(self, code=200, value=None, content_type='application/json; charset=utf-8', cookie=None):
        raw = (json.dumps(value, ensure_ascii=False).encode('utf8')
               if not isinstance(value, (bytes, bytearray)) else value)
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(raw)

    def error(self, status, msg):
        self.respond(status, {'error': msg})

    def body(self):
        size = int(self.headers.get('Content-Length', '0'))
        if size > 100000:
            raise ValueError('Solicitud demasiado grande')
        return json.loads(self.rfile.read(size) or '{}')

    def session(self):
        cookie = self.headers.get('Cookie', '')
        sid = next((x.strip()[4:] for x in cookie.split(';') if x.strip().startswith('sid=')), None)
        with LOCK:
            entry = SESSIONS.get(sid)
            if entry and entry['expires'] > time.time():
                return entry
        return None

    def authorized(self, write=False):
        sess = self.session()
        if not sess:
            self.error(401, 'Iniciá sesión como administrador')
            return False
        if write and not hmac.compare_digest(self.headers.get('X-CSRF', ''), sess['csrf']):
            self.error(403, 'Token de seguridad incorrecto')
            return False
        return True

    def do_GET(self):
        try:
            self.get()
        except (ValueError, sqlite3.IntegrityError) as e:
            self.error(400, str(e))
        except Exception as e:
            print('ERROR GET', repr(e))
            self.error(500, 'Error interno')

    def get(self):
        u = urlparse(self.path)
        p = u.path
        q = parse_qs(u.query)

        if p in ('/', '/index.html'):
            return self.respond(200, STATIC.read_bytes(), 'text/html; charset=utf-8')

        if p == '/api/session':
            s = self.session()
            return self.respond(200, {'authenticated': bool(s), 'csrf': s['csrf'] if s else None})

        if p.startswith('/api/invitacion/'):
            token = p.split('/')[-1]
            with dbconn() as c:
                r = c.execute('''
                    SELECT i.respuesta, r.titulo, r.fecha, r.lugar, r.descripcion, s.nombre
                    FROM invitaciones i
                    JOIN reuniones r ON r.id = i.reunion_id
                    JOIN socios s ON s.id = i.socio_id
                    WHERE i.token = ?
                ''', (token,)).fetchone()
            if not r:
                return self.error(404, 'Invitación no encontrada')
            return self.respond(200, dict(r))

        if p.startswith('/api/') and not self.authorized():
            return

        if p == '/api/socios':
            with dbconn() as c:
                rows = c.execute('SELECT * FROM socios ORDER BY nombre').fetchall()
            return self.respond(200, [dict(x) for x in rows])

        if p == '/api/reuniones':
            with dbconn() as c:
                rows = c.execute('SELECT * FROM reuniones ORDER BY fecha DESC, id DESC').fetchall()
            return self.respond(200, [dict(x) for x in rows])

        if p == '/api/reporte':
            mid = int((q.get('id') or ['0'])[0])
            with dbconn() as c:
                meeting = c.execute('SELECT * FROM reuniones WHERE id = ?', (mid,)).fetchone()
                if not meeting:
                    return self.error(404, 'Reunión no encontrada')
                rows = [dict(x) for x in c.execute('''
                    SELECT i.id, s.nombre, s.telefono, i.token, i.respuesta, i.respondido, i.presente, i.registrado
                    FROM invitaciones i
                    JOIN socios s ON s.id = i.socio_id
                    WHERE i.reunion_id = ?
                    ORDER BY s.nombre
                ''', (mid,))]

            if 'csv' in q:
                out = io.StringIO()
                w = csv.writer(out, delimiter=';')
                w.writerow(['Socio', 'Teléfono', 'Respuesta', 'Fecha respuesta', 'Presente', 'Fecha check-in'])
                for r in rows:
                    w.writerow([
                        r['nombre'], r['telefono'], r['respuesta'],
                        r['respondido'] or '', 'Sí' if r['presente'] else 'No',
                        r['registrado'] or ''
                    ])
                raw = ('\ufeff' + out.getvalue()).encode('utf-8')
                return self.respond(200, raw, 'text/csv; charset=utf-8')

            counts = {x: sum(1 for r in rows if r['respuesta'] == x) for x in ('si', 'no', 'quizas', 'pendiente')}
            counts['total'] = len(rows)
            counts['presentes'] = sum(r['presente'] for r in rows)
            return self.respond(200, {
                'reunion': dict(meeting),
                'invitaciones': rows,
                'totales': counts
            })

        return self.error(404, 'No encontrado')

    def do_POST(self):
        try:
            self.post()
        except (ValueError, sqlite3.IntegrityError) as e:
            self.error(400, str(e))
        except Exception as e:
            print('ERROR POST', repr(e))
            self.error(500, 'Error interno')

    def post(self):
        p = urlparse(self.path).path
        data = self.body()

        if p == '/api/login':
            cfg = json.loads(CONFIG.read_text(encoding='utf8'))
            if not checkpass(str(data.get('password', '')), cfg['password_hash']):
                time.sleep(0.35)
                return self.error(401, 'Contraseña incorrecta')
            sid = secrets.token_urlsafe(32)
            csrf = secrets.token_urlsafe(32)
            with LOCK:
                SESSIONS[sid] = {'expires': time.time() + 3600 * 12, 'csrf': csrf}

            proto = self.headers.get('X-Forwarded-Proto', '').lower()
            secure = '; Secure' if proto == 'https' or self.headers.get('X-Forwarded-Port') == '443' else ''
            return self.respond(200, {'ok': True, 'csrf': csrf},
                                cookie=f'sid={sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200{secure}')

        if p.startswith('/api/responder/'):
            token = p.rsplit('/', 1)[-1]
            ans = str(data.get('respuesta', ''))
            if ans not in ('si', 'no', 'quizas'):
                return self.error(400, 'Respuesta inválida')
            with dbconn() as c:
                cur = c.execute(
                    'UPDATE invitaciones SET respuesta = ?, respondido = ? WHERE token = ?',
                    (ans, now(), token)
                )
                if cur.rowcount == 0:
                    return self.error(404, 'Invitación no encontrada')
            return self.respond(200, {'ok': True})

        if p.startswith('/api/') and not self.authorized(write=True):
            return

        if p == '/api/socios/crear':
            nombre = str(data.get('nombre', '')).strip()
            telefono = str(data.get('telefono', '')).strip()
            if not nombre:
                return self.error(400, 'El nombre es obligatorio')
            with dbconn() as c:
                c.execute('INSERT INTO socios(nombre, telefono, creado) VALUES(?,?,?)',
                          (nombre, telefono, now()))
            return self.respond(200, {'ok': True})

        if p == '/api/socios/importar':
            socios = data.get('socios') or []
            if not isinstance(socios, list) or not socios:
                return self.error(400, 'Debes enviar una lista de socios')

            insertados = 0
            with dbconn() as c:
                for s in socios:
                    nombre = str(s.get('nombre', '')).strip()
                    telefono = str(s.get('telefono', '')).strip()
                    if not nombre:
                        continue
                    # Evitar duplicados por nombre
                    existe = c.execute('SELECT id FROM socios WHERE nombre = ?', (nombre,)).fetchone()
                    if existe:
                        continue
                    c.execute(
                        'INSERT INTO socios(nombre, telefono, creado) VALUES(?,?,?)',
                        (nombre, telefono, now())
                    )
                    insertados += 1
            return self.respond(200, {'ok': True, 'insertados': insertados})

        if p == '/api/reuniones/crear':
            titulo = str(data.get('titulo', '')).strip()
            fecha = str(data.get('fecha', '')).strip()
            lugar = str(data.get('lugar', '')).strip()
            desc = str(data.get('descripcion', '')).strip()
            if not titulo or not fecha:
                return self.error(400, 'Título y fecha son obligatorios')
            with dbconn() as c:
                c.execute(
                    'INSERT INTO reuniones(titulo, fecha, lugar, descripcion, creado) VALUES(?,?,?,?,?)',
                    (titulo, fecha, lugar, desc, now())
                )
            return self.respond(200, {'ok': True})

        if p == '/api/invitaciones/crear':
            reunion_id = int(data.get('reunion_id', 0))
            socio_ids = data.get('socio_ids') or []
            if not reunion_id or not socio_ids:
                return self.error(400, 'reunion_id y socio_ids son obligatorios')
            with dbconn() as c:
                for sid in socio_ids:
                    token = secrets.token_urlsafe(24)
                    try:
                        c.execute(
                            'INSERT INTO invitaciones(reunion_id, socio_id, token) VALUES(?,?,?)',
                            (reunion_id, int(sid), token)
                        )
                    except sqlite3.IntegrityError:
                        pass
            return self.respond(200, {'ok': True})

        if p == '/api/asistencia':
            inv_id = int(data.get('id', 0))
            presente = 1 if data.get('presente') else 0
            with dbconn() as c:
                cur = c.execute(
                    'UPDATE invitaciones SET presente = ?, registrado = ? WHERE id = ?',
                    (presente, now() if presente else None, inv_id)
                )
                if cur.rowcount == 0:
                    return self.error(404, 'Invitación no encontrada')
            return self.respond(200, {'ok': True})

        if p == '/api/socios/eliminar':
            sid = int(data.get('id', 0))
            with dbconn() as c:
                c.execute('DELETE FROM socios WHERE id = ?', (sid,))
            return self.respond(200, {'ok': True})

        if p == '/api/reuniones/eliminar':
            rid = int(data.get('id', 0))
            with dbconn() as c:
                c.execute('DELETE FROM reuniones WHERE id = ?', (rid,))
            return self.respond(200, {'ok': True})

        return self.error(404, 'No encontrado')

def main():
    parser = argparse.ArgumentParser(description='Club Asistencia')
    parser.add_argument('--set-password', metavar='PASS', nargs='?', const=True)
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', 8080)))
    args = parser.parse_args()

    if args.set_password is not None:
        setpassword_cli(None if args.set_password is True else args.set_password)
        return

    # Crear config.json automáticamente desde variable de entorno
    if not CONFIG.exists():
        password = os.environ.get('ADMIN_PASSWORD')
        if not password:
            print('ERROR: Falta la variable de entorno ADMIN_PASSWORD')
            return
        if len(password) < 10:
            print('ERROR: ADMIN_PASSWORD debe tener al menos 10 caracteres')
            return
        CONFIG.write_text(json.dumps({'password_hash': hashpass(password)}, indent=2), encoding='utf8')
        print('Contraseña configurada desde ADMIN_PASSWORD')

    initdb()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'Servidor escuchando en puerto {args.port}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()

if __name__ == '__main__':
    main()
