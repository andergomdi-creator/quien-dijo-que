# 🕵️ ¿Quién dijo qué? — Party game web

```
party-game/
├── backend/    Node.js + Socket.io (→ Render)
│   ├── server.js
│   ├── questions.json   (20 de muestra; sustitúyelo por tus 500)
│   └── package.json
└── frontend/   HTML + JS vanilla (→ Vercel)
    └── index.html
```

## Probar en local

```bash
cd backend
npm install
npm start            # http://localhost:3000 (también sirve ../frontend)
```

- Abre `http://localhost:3000` en el ordenador → **Crear sala**.
- Para probar con móviles reales, abre la web desde el ordenador con tu IP local
  (`http://192.168.x.x:3000`) para que el QR apunte a esa IP. Móvil y PC en la misma wifi.
- Para probar rápido sin móviles: abre 3 pestañas más con `?room=XXXX` (o escribe el código).

## Desplegar el backend en Render (gratis)

1. Sube el proyecto a un repositorio de GitHub.
2. En [render.com](https://render.com): **New → Web Service** → conecta el repo.
3. Configura:
   - **Root Directory:** `backend`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
4. En **Environment** añade `FRONTEND_URL` = la URL de Vercel (p. ej. `https://mi-juego.vercel.app`).
   Puedes dejarlo vacío al principio (acepta cualquier origen) y restringirlo después.
5. Copia la URL del servicio (`https://xxxx.onrender.com`). Comprueba `https://xxxx.onrender.com/health`.

> ⚠️ El plan gratuito de Render se **duerme tras ~15 min sin tráfico** y tarda ~30-60 s en despertar.
> Abre `/health` un minuto antes de jugar.

## Desplegar el frontend en Vercel (gratis)

1. En `frontend/index.html`, cambia `PROD_BACKEND` por la URL de Render.
2. En [vercel.com](https://vercel.com): **Add New → Project** → importa el mismo repo.
3. **Root Directory:** `frontend`. Framework Preset: *Other*. Sin build command ni output directory.
4. Deploy. Vuelve a Render y pon esa URL en `FRONTEND_URL`.

Alternativa por CLI: `cd frontend && npx vercel --prod`.

## Reglas implementadas

| Regla | Dónde |
|---|---|
| 3–8 jugadores, código de 4 letras + QR | `host:start`, `player:join` |
| 10 preguntas al azar de `questions.json` | `startAnswering()` |
| Respuestas ligadas solo a `socket.id` | `room.answers: Map<socketId, string[]>` |
| Revelación en orden aleatorio | `buildItems()` → `shuffle` |
| Auto-voto: `voto.socketId === autor.socketId` | `player:vote` (marca `auto: true`) |
| Auto-voto no puntúa y se excluye del bonus | `closeVoting()` (`validVotes`) |
| +100 por acierto, +150 si nadie más acierta | `CONFIG.POINTS_*` |

Ajustes en `CONFIG` (arriba de `server.js`): tiempos, puntos, y `REVEAL_ALL_ANSWERS=true` (variable de entorno)
para revelar todas las respuestas de todos en vez de una por pregunta.

## Limitaciones conocidas

- Estado **en memoria**: si Render reinicia el servicio, se pierden las salas.
- Identidad = `socket.id`: si un móvil pierde la conexión a mitad de partida, no puede volver a la misma partida
  (en el lobby sí se reenlaza solo). Mejora futura: token de jugador en `localStorage`.
