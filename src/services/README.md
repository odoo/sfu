# Services

This directory contains the core infrastructure services that power the SFU. These services manage network protocols, authentication, and system resources.

## Overview

```mermaid
graph TD
    Client[Browser Client]
    Server[Odoo Server]
    HTTP[HTTP Service]
    WS[WebSocket Service]
    Auth[Auth Service]
    Channel[Channel Model]
    Resources[Resources Service]
    Session[Session Model]

    Server ---->|REST API| HTTP
    Auth ---|verify| HTTP
    Auth ---|verify| WS
    Client ---->|WebSocket| WS
    Resources -->|Get Worker| Channel
    HTTP -->|Create/Get| Channel
    WS -->|Join| Channel
    Channel --> Session

    classDef service fill:#f96,stroke:#333,stroke-width:2px,color:#000;
    class HTTP,WS,Auth,Resources service;
```

## Service Modules

### 1. Auth Service (`auth.ts`)

The Authentication service is responsible for the security of the application. It handles the signing and verification of JSON Web Tokens (JWT).

### 2. HTTP Service (`http.ts`)

The HTTP service provides the REST API for the SFU. It handles channel creation, status checks, and session management.

**Key Endpoints:**

| Method | Endpoint         | Description                                         |
| ------ | ---------------- | --------------------------------------------------- |
| `GET`  | `/v1/channel`    | Creates or retrieves a media channel. Requires JWT. |
| `POST` | `/v1/disconnect` | Disconnects specific sessions from a channel.       |
| `GET`  | `/v1/stats`      | Returns statistics for all active channels.         |
| `GET`  | `/v1/noop`       | Health check endpoint.                              |

### 3. WebSocket Service (`ws.ts`)

The WebSocket service manages real-time, persistent connections with clients. It is the primary transport for signaling data once a session is established.

```mermaid
sequenceDiagram
    participant C as Client
    participant WS as WebSocket Service
    participant A as Auth Service
    participant S as Session

    C->>WS: Connect
    WS-->>C: Open (Wait for Auth)
    C->>WS: Send Credentials {jwt, channelUUID}
    WS->>A: Verify JWT
    WS->>S: Create & Join Session
    WS-->>C: Send Startup Data
    loop Traffic
        C->>S: Bus Message
        S-->>C: Bus Message
        C->>S: UDP streaming
        S-->>C: UDP streaming
    end
```

### 4. Resources Service (`resources.ts`)

The Resources service acts as the interface to the underlying system and Mediasoup library. It manages the pool of worker processes and system resources.

**Responsibilities:**
- **Worker Management**: Maintains a pool of Mediasoup workers. Automatically replaces workers if they crash.
- **Load Balancing**: `getWorker()` returns the worker with the lowest memory usage (`ru_maxrss`).
- **File System**: Manages temporary folders for recordings via the `Folder` class.
- **Port Management**: Allocates dynamic ports for media transport using the `DynamicPort` class.
