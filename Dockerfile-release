FROM node:16 AS build
ENV NODE_ENV=production
WORKDIR /home/node/mining-pool
RUN curl -o mining-pool-latest.tar.gz -L https://api.github.com/repos/alephium/mining-pool/tarball
RUN tar -xf mining-pool-latest.tar.gz && rm mining-pool-latest.tar.gz
RUN cd * && mv ./* ../. && cd ..
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
