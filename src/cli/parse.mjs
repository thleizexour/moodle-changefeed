const CONFIG_VALUE_FLAGS = new Set([
  "--site-url",
  "--data-dir",
  "--archive-root",
  "--domains",
  "--max-file-bytes",
  "--max-batch-bytes",
  "--course-concurrency"
]);

function splitConfigArgs(argv) {
  const commandArgv = [];
  const configArgv = [];
  let siteUrl;
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (/^--(?:token|moodle-token|webservice-token|ics-url)(?:=|$)/i.test(raw)) {
      throw new TypeError(
        "Moodle token and ICS URL must come from the environment or a credential provider"
      );
    }
    const flag = raw.split("=", 1)[0];
    if (!CONFIG_VALUE_FLAGS.has(flag)) {
      commandArgv.push(raw);
      continue;
    }
    configArgv.push(raw);
    if (raw.includes("=")) {
      if (flag === "--site-url") siteUrl = raw.slice(raw.indexOf("=") + 1);
    } else {
      const value = argv[++index];
      if (value === undefined) throw new TypeError(`${flag} requires a value`);
      configArgv.push(value);
      if (flag === "--site-url") siteUrl = value;
    }
  }
  return { commandArgv, configArgv, siteUrl };
}

function parseOptions(argv, definitions) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const equals = raw.indexOf("=");
    const flag = equals > 0 ? raw.slice(0, equals) : raw;
    const definition = definitions[flag];
    if (!definition) throw new TypeError(`Unknown option: ${flag}`);
    if (definition.kind === "boolean") {
      if (equals > 0) throw new TypeError(`${flag} does not accept a value`);
      if (Object.hasOwn(output, definition.key)) throw new TypeError(`${flag} is duplicated`);
      output[definition.key] = definition.value ?? true;
      continue;
    }
    const value = equals > 0 ? raw.slice(equals + 1) : argv[++index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new TypeError(`${flag} requires a value`);
    }
    const parsed = definition.kind === "integer" ? Number(value) : value;
    if (definition.kind === "integer" && (!Number.isSafeInteger(parsed) || parsed < 1)) {
      throw new TypeError(`${flag} requires a positive integer`);
    }
    if (definition.multiple) {
      (output[definition.key] ||= []).push(parsed);
    } else {
      if (Object.hasOwn(output, definition.key)) throw new TypeError(`${flag} is duplicated`);
      output[definition.key] = parsed;
    }
  }
  return output;
}

function requireId(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

export function parseCli(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const { commandArgv, configArgv, siteUrl } = splitConfigArgs(argv);
  const [first = "help", second, third, ...rest] = commandArgv;

  if (["help", "--help", "-h"].includes(first)) {
    if (commandArgv.length > 1) throw new TypeError("help does not accept arguments");
    return { command: "help", input: {}, configArgv };
  }
  if (first === "bootstrap") {
    if (commandArgv.length > 1) throw new TypeError("bootstrap does not accept arguments");
    return { command: first, input: {}, configArgv, siteUrl };
  }
  if (first === "status") {
    if (commandArgv.length > 1) throw new TypeError("status does not accept arguments");
    return { command: first, input: {}, configArgv };
  }
  if (first === "sync") {
    return {
      command: "sync",
      input: parseOptions(commandArgv.slice(1), {
        "--course-id": { key: "courseIds", kind: "string", multiple: true }
      }),
      configArgv,
      siteUrl
    };
  }
  if (first === "feed") {
    return {
      command: "feed",
      input: parseOptions(commandArgv.slice(1), {
        "--cursor": { key: "cursor", kind: "string" },
        "--limit": { key: "limit", kind: "integer" },
        "--review-status": { key: "reviewStatus", kind: "string" },
        "--course-id": { key: "courseId", kind: "string" },
        "--type": { key: "type", kind: "string" }
      }),
      configArgv
    };
  }
  if (first === "review" && second === "show") {
    const id = requireId(third, "review item id");
    if (rest.length) throw new TypeError("review show does not accept extra arguments");
    return { command: "review.show", input: { id }, configArgv };
  }
  if (first === "review" && second === "decide") {
    const id = requireId(third, "review item id");
    const options = parseOptions(rest, {
      "--expected-version": { key: "expectedVersion", kind: "integer" },
      "--approve": { key: "decision", kind: "boolean", value: "approve" },
      "--ignore": { key: "decision", kind: "boolean", value: "ignore" },
      "--defer": { key: "decision", kind: "boolean", value: "defer" },
      "--resume": { key: "decision", kind: "boolean", value: "resume" }
    });
    if (!options.expectedVersion || !options.decision) {
      throw new TypeError("review decide requires expected version and one decision");
    }
    return { command: "review.decide", input: { id, ...options }, configArgv };
  }
  if (first === "cache") {
    return {
      command: "cache",
      input: parseOptions(commandArgv.slice(1), {
        "--resource-id": { key: "resourceIds", kind: "string", multiple: true },
        "--review-item-id": { key: "reviewItemIds", kind: "string", multiple: true }
      }),
      configArgv
    };
  }
  if (first === "delivery" && second === "prepare") {
    return {
      command: "delivery.prepare",
      input: parseOptions(commandArgv.slice(2), {
        "--review-item-id": { key: "reviewItemIds", kind: "string", multiple: true },
        "--target": { key: "targets", kind: "string", multiple: true }
      }),
      configArgv
    };
  }
  if (first === "delivery" && second === "execute") {
    return {
      command: "delivery.execute",
      input: parseOptions(commandArgv.slice(2), {
        "--plan-hash": { key: "planHash", kind: "string" },
        "--confirmation-token": { key: "confirmationToken", kind: "string" }
      }),
      configArgv
    };
  }
  if (first === "demo") {
    return {
      command: "demo",
      input: parseOptions(commandArgv.slice(1), {
        "--fixture": { key: "fixture", kind: "string" }
      }),
      configArgv
    };
  }
  throw new TypeError(`Unknown command: ${[first, second].filter(Boolean).join(" ")}`);
}

export const CLI_HELP = `moodle-changefeed commands:
  bootstrap
  sync [--course-id <id>]
  feed [--limit <n>] [--review-status <status>]
  review show <id>
  review decide <id> --expected-version <n> --approve|--ignore|--defer|--resume
  cache --resource-id <id>|--review-item-id <id>
  delivery prepare --review-item-id <id> [--target local_archive]
  delivery execute --plan-hash <hash>
  status
  demo --fixture anonymous/basic

Secrets: MOODLE_CHANGEFEED_TOKEN and MOODLE_CHANGEFEED_ICS_URL only.`;
