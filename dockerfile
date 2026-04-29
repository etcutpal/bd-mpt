FROM node:20-alpine
WORKDIR /usr/src/mpt
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 5001
CMD ["node", "server.js"]
