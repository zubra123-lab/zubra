# Immagine per Fly.io — Zubra backend (Node + Express)
FROM node:20-alpine

WORKDIR /app

# Installa solo le dipendenze di produzione (sfrutta la cache di Docker)
COPY package*.json ./
RUN npm install --omit=dev

# Copia il resto del codice (public/, server.js, ecc.)
COPY . .

# Fly instrada il traffico sulla porta interna 8080
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
