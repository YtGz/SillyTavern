#!/bin/sh

if [ ! -e "config/config.yaml" ]; then
    echo "Resource not found, copying from defaults: config.yaml"
    cp -r "default/config.yaml" "config/config.yaml"
fi

# Execute postinstall to auto-populate config.yaml with missing values
bun run postinstall

# Start the server
exec bun run server.js --listen "$@"
