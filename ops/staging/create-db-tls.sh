#!/bin/sh
set -eu
directory="${1:?Pass an empty private certificate directory}"
umask 077
mkdir -p "$directory"
for name in ca.key ca.crt server.key server.crt; do
  if [ -e "$directory/$name" ]; then
    echo 'Refusing to overwrite existing database TLS files' >&2
    exit 1
  fi
done
openssl req -x509 -newkey rsa:3072 -nodes -days 14 -subj '/CN=CEDA fictional staging DB CA' -keyout "$directory/ca.key" -out "$directory/ca.crt" 2>/dev/null
openssl req -newkey rsa:3072 -nodes -subj '/CN=postgres' -keyout "$directory/server.key" -out "$directory/server.csr" 2>/dev/null
printf '%s\n' 'subjectAltName=DNS:postgres' 'extendedKeyUsage=serverAuth' 'basicConstraints=CA:FALSE' 'keyUsage=digitalSignature,keyEncipherment' > "$directory/server.ext"
openssl x509 -req -days 14 -in "$directory/server.csr" -CA "$directory/ca.crt" -CAkey "$directory/ca.key" -CAcreateserial -extfile "$directory/server.ext" -out "$directory/server.crt" 2>/dev/null
chmod 644 "$directory/ca.crt" "$directory/server.crt"
chmod 755 "$directory"
echo 'Database TLS files created. Restrict server.key ownership for the PostgreSQL container before startup.'
