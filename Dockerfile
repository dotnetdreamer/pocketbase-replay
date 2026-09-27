FROM alpine:3.22
RUN apk add --no-cache unzip ca-certificates
ADD --checksum=sha256:4c5a1aced62ebf658bfbcfeaa944c4bfa88b173dd9d598d3cab55ea63587b36b \
    https://github.com/pocketbase/pocketbase/releases/download/v0.39.9/pocketbase_0.39.9_linux_amd64.zip /tmp/pb.zip
RUN unzip /tmp/pb.zip -d /pb && rm /tmp/pb.zip
COPY server/pb_hooks /pb/pb_hooks
COPY server/pb_migrations /pb/pb_migrations
COPY server/pb_migrations_dedicated/ /pb/pb_migrations/
WORKDIR /pb
EXPOSE 8090
CMD ["/pb/pocketbase", "serve", "--http=0.0.0.0:8090"]
