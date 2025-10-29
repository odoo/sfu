export class AuthenticationError extends Error {
    name = "AuthenticationError";
}

export class OvercrowdedError extends Error {
    name = "OvercrowdedError";
}

export class PortLimitReachedError extends Error {
    name = "PortLimitReachedError";
}
