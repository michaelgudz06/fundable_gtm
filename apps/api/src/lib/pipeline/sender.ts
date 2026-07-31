/**
 * Named sender-context blocks (PRD §4: `sender_context`).
 *
 * Resolved from the static registry rather than the filesystem — see
 * `lib/config-registry.ts` for why. An unknown name is a warning, not an error:
 * the message still writes, it just loses the sender-side facts. `default` loads
 * implicitly when the caller names nothing.
 */

import { SENDERS } from "../config-registry";
import type { SenderContext } from "./facts";

export function loadSenderContext(name: string | undefined): {
  sender: SenderContext | null;
  warnings: string[];
} {
  const id = name ?? "default";

  // The route already validated the shape; re-check before it is used as a key.
  if (!/^[a-z0-9_-]{1,64}$/i.test(id)) {
    return { sender: null, warnings: ["Invalid sender_context name; ignored."] };
  }

  const found = SENDERS[id];
  if (!found) {
    return {
      sender: null,
      warnings: [
        `sender_context "${id}" is not registered; writing without sender facts. Known: ${Object.keys(SENDERS).join(", ")}.`,
      ],
    };
  }

  if (!Array.isArray(found.sender_facts)) {
    return { sender: null, warnings: [`sender_context "${id}" has no sender_facts array; ignored.`] };
  }

  return { sender: { ...found, id }, warnings: [] };
}
