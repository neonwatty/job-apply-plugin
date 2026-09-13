"""Interruptible socket I/O without imposing a user-facing idle deadline."""

import socket


class WorkspaceConnection(socket.socket):
    """Poll the server close event inside I/O, before SocketIO sees a timeout."""

    def __init__(self, connection, closing):
        super().__init__(connection.family, connection.type, connection.proto,
                         fileno=connection.detach())
        self.closing = closing
        self.settimeout(0.2)

    def recv_into(self, buffer, nbytes=0, flags=0):
        while not self.closing.is_set():
            try:
                return super().recv_into(buffer, nbytes, flags)
            except socket.timeout:
                continue
            except OSError:
                if self.closing.is_set():
                    return 0
                raise
        return 0

    def sendall(self, data, flags=0):
        with memoryview(data).cast('B') as pending:
            offset = 0
            while offset < len(pending):
                if self.closing.is_set():
                    raise BrokenPipeError("workspace connection is closing")
                try:
                    sent = super().send(pending[offset:], flags)
                except socket.timeout:
                    continue
                except OSError:
                    if self.closing.is_set():
                        raise BrokenPipeError("workspace connection is closing") from None
                    raise
                if sent == 0:
                    raise BrokenPipeError("workspace connection closed")
                offset += sent
