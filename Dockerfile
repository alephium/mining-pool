FROM node:16 AS build
ENV NODE_ENV=production
WORKDIR /home/node/mining-pool
ADD https://github.com/alephium/mining-pool/archive/refs/tags/v1.3.0.tar.gz ./
RUN tar -xf v1.3.0.tar.gz
RUN mv mining-pool-1.3.0/* ./ && rm -r mining-pool-1.3.0 v1.3.0.tar.gz
RUN npm install

FROM node:16 AS run
ENV NODE_ENV=production
WORKDIR /home/node/mining-pool
COPY --from=build /home/node/mining-pool ./
RUN mkdir logs && chown node logs
RUN apt-get update && apt install -y tini
EXPOSE 20032
VOLUME /logs
USER node
ENTRYPOINT ["/usr/bin/tini","--","node","./init.js"]
