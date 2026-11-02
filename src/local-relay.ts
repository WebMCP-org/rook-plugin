import { localRelayOrigin } from "./wire/relay";

export const LOCAL_RELAY_ORIGIN = localRelayOrigin(process.env.ROOK_RELAY_PORT);
