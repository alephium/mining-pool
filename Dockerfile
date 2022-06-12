FROM node:16-alpine AS build
RUN apk add python3
RUN ln -sf /usr/bin/python3 /usr/bin/python
RUN apk add build-base
ENV NODE_ENV=production
WORKDIR /home/node/mining-pool
ADD package.json package.json
ADD package-lock.json package-lock.json
RUN npm ci

FROM node:16-alpine AS run

USER node
COPY --from=build /home/node/mining-pool/node_modules /home/node/mining-pool/node_modules

USER root
RUN apk add tini
RUN mkdir /home/node/mining-pool/logs && chown node /home/node/mining-pool/logs

USER node
WORKDIR /home/node/mining-pool

ENV NODE_ENV=production

EXPOSE 20032
VOLUME /home/node/mining-pool/logs

ADD ./package.json /home/node/mining-pool/package.json
ADD ./lib /home/node/mining-pool/lib

ENTRYPOINT ["/sbin/tini","--","npm","run","start"]
