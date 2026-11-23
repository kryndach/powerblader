FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY games ./games
COPY public ./public
COPY server ./server
COPY src ./src
EXPOSE 8080
ENV PORT=8080
CMD ["npm", "start"]
