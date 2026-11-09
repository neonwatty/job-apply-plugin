# Packaged native lock

Plugin package assembly creates one `platform-arch-napi8` directory here. Each
directory contains `flock.node` and a receipt binding the artifact to the reviewed
source, host platform, architecture, and Node-API version. Runtime code verifies
the receipt and never compiles or downloads an addon.
