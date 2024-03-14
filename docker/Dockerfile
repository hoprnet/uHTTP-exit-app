# Specify platform to be amd because arm doesn't work
FROM --platform=linux/amd64 node:18-alpine as builder

RUN apk upgrade --no-cache

WORKDIR /app

# Copy app source
COPY package.json \
     src/ \
     tsconfig.json \
     yarn.lock .

RUN yarn install --frozen-lockfile

# Build the project.
RUN yarn run build

# prepare for production
RUN rm -R node_modules && \
    yarn config set nmMode hardlinks-local && \
    yarn install --production --frozen-lockfile

# Specify platform to be amd because arm doesn't work
FROM --platform=linux/amd64 alpine:3 as runner

ENV LOGGER=false

WORKDIR /app

RUN apk upgrade --no-cache && \
    apk add --no-cache nodejs tini && \
    addgroup -g 104 -S node && \
    adduser -u 104 -D -S -G node node

# copy over minimal fileset to run availability-monitor
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json .
COPY --from=builder build ./build

ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "build/index.js"]
