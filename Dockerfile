FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3001

CMD ["sh", "-c", "npm run migrate && npm start"]
