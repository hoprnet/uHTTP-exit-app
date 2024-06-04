# u(nlinked)HTTP exit application

## Description

uHTTP exit application attaches to an exit node and performs arbitrary incoming HTTP requests for clients.

## Deployment

CI will create a new container image on a tagged version on main.

-   run `yarn changeset version` to create the current changelog
-   run `yarn build` to update version info
-   commit everything, create a matching tag and push to main

## Run with Docker

To be able to run the Exit Node with Docker, you first need to build the image, for that, we will use the following command

```sh
docker build -t exit-node -f Dockerfile ../../
```

After building the image, you will be able to run it with: \
(replace the values that have `< >`)

```sh
docker run \
-e HOPRD_API_ENDPOINT=<HOPRD NODE TO LISTEN TO> \
-e HOPRD_API_TOKEN=<HOPRD NODE ACCESS TOKEN> \
-e DEBUG="*" \
-e DISCOVERY_PLATFORM_API_ENDPOINT=<URL TO DP> \
-e DISCOVERY_PLATFORM_ACCESS_TOKEN=<DP ACCESS TOKEN> \
exit-node
```

## Run with Docker Compose (run hoprd node too)

To run a exit-node and a hoprd node at the same time, run the following command in the exit-node directory:

```sh
docker compose up
```

When wanting to stop the exit-node and hoprd node, you can:

For linux or windows: `CTRL + C`

For OSX: `CMD + C`

or if you are running the docker as a daemon, execute the following command in the exit-node directory:

```sh
docker compose down
```
