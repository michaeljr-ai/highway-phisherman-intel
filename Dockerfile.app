FROM node:22-bookworm
WORKDIR /app

COPY scripts/install_osint_tools.sh /tmp/install_osint_tools.sh
RUN bash /tmp/install_osint_tools.sh && rm -f /tmp/install_osint_tools.sh

COPY --chown=node:node package.json package-lock.json ./
USER node
RUN npm install
COPY --chown=node:node . .
ENV PASSIVE_CLI_RECON_ENABLED=true
EXPOSE 4010
CMD ["npm", "start"]
