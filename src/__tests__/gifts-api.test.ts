import { describe, it, expect } from "vitest";
import { GiftsApi, GiftsApiError } from "../gifts-api";
import { withRosterApi } from "./roster-api-mock";

describe("GiftsApi", () => {
  it("creates an invoice", async () => {
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async () =>
        new Response(
          JSON.stringify({
            id: "1",
            pr: "lnbc1",
            paymentHash: "aa".repeat(32),
            amountMsat: 1000,
          }),
          { status: 200 },
        ),
    );
    const inv = await api.createInvoice("a@b.com", 1000, "1.00", "hi");
    expect(inv.id).toBe("1");
  });

  it("normalises an uppercase paymentHash", async () => {
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async () =>
        new Response(
          JSON.stringify({
            id: "1",
            pr: "lnbc1",
            paymentHash: "AA".repeat(32),
            amountMsat: 1000,
          }),
          { status: 200 },
        ),
    );
    const inv = await api.createInvoice("a@b.com", 1000, "1.00");
    expect(inv.paymentHash).toBe("aa".repeat(32));
  });

  it("throws GiftsApiError on 401", async () => {
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        }),
    );
    await expect(
      api.createInvoice("a@b.com", 1000, "1.00"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("maps network failure to status 0", async () => {
    const api = new GiftsApi("https://api.21.gifts", "tok", async () => {
      throw new Error("offline");
    });
    await expect(api.submitProof("1", "11".repeat(32))).rejects.toBeInstanceOf(
      GiftsApiError,
    );
  });

  it("rejects a malformed 200 body", async () => {
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async () => new Response("{}", { status: 200 }),
    );
    await expect(
      api.createInvoice("a@b.com", 1000, "1.00"),
    ).rejects.toMatchObject({ status: 0 });
  });

  it("rejects a malformed paymentHash as status 0", async () => {
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async () =>
        new Response(
          JSON.stringify({
            id: "1",
            pr: "lnbc1",
            paymentHash: "zz",
            amountMsat: 1000,
          }),
          { status: 200 },
        ),
    );
    await expect(
      api.createInvoice("a@b.com", 1000, "1.00"),
    ).rejects.toMatchObject({ status: 0 });
  });

  it("createInvoice JSON includes messageId when the 5th argument is passed", async () => {
    let sent: unknown;
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async (_url, init) => {
        sent = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "1",
            pr: "lnbc1",
            paymentHash: "aa".repeat(32),
            amountMsat: 1000,
          }),
          { status: 200 },
        );
      },
    );
    await api.createInvoice(
      "a@b.com",
      1000,
      "5.00",
      "hi",
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    expect(sent).toEqual({
      address: "a@b.com",
      amountMsat: 1000,
      amountUsd: "5.00",
      comment: "hi",
      messageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });
  });

  it("createInvoice JSON omits messageId when it is not passed", async () => {
    let sent: unknown;
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async (_url, init) => {
        sent = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "1",
            pr: "lnbc1",
            paymentHash: "aa".repeat(32),
            amountMsat: 1000,
          }),
          { status: 200 },
        );
      },
    );
    await api.createInvoice("a@b.com", 1000, "5.00", "hi");
    expect(sent).toEqual({
      address: "a@b.com",
      amountMsat: 1000,
      amountUsd: "5.00",
      comment: "hi",
    });
    expect(sent).not.toHaveProperty("messageId");
    expect(sent).not.toHaveProperty("groupMessageId");
  });

  it("createInvoice JSON includes groupMessageId when the 6th argument is passed", async () => {
    let sent: unknown;
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async (_url, init) => {
        sent = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "1",
            pr: "lnbc1",
            paymentHash: "aa".repeat(32),
            amountMsat: 1000,
          }),
          { status: 200 },
        );
      },
    );
    await api.createInvoice(
      "a@b.com",
      1000,
      "5.00",
      "hi",
      undefined,
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );
    expect(sent).toEqual({
      address: "a@b.com",
      amountMsat: 1000,
      amountUsd: "5.00",
      comment: "hi",
      groupMessageId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    });
    expect(sent).not.toHaveProperty("messageId");
  });

  it("dailyInstruction accepts every skip reason", async () => {
    const reasons = [
      "no_passkey",
      "no_post",
      "no_media",
      "not_eligible",
      "payments_disabled",
      "not_listed",
      "undecided",
      "welcome_paid",
    ] as const;
    for (const reason of reasons) {
      let seenUrl = "";
      let auth = "";
      let sent: unknown;
      const api = new GiftsApi(
        "https://api.21.gifts",
        "tok",
        async (url, init) => {
          seenUrl = String(url);
          auth = new Headers(init?.headers).get("authorization") ?? "";
          sent = JSON.parse(String(init?.body ?? "{}"));
          return new Response(JSON.stringify({ action: "skip", reason }), {
            status: 200,
          });
        },
      );
      await expect(api.dailyInstruction("a@b.com")).resolves.toEqual({
        action: "skip",
        reason,
      });
      expect(seenUrl).toBe("https://api.21.gifts/spend/daily-instruction");
      expect(auth).toBe("Bearer tok");
      expect(sent).toEqual({ address: "a@b.com" });
    }
  });

  it("dailyInstruction rejects an unknown skip reason", async () => {
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async () =>
        new Response(JSON.stringify({ action: "skip", reason: "nope" }), {
          status: 200,
        }),
    );
    await expect(api.dailyInstruction("a@b.com")).rejects.toMatchObject({
      status: 0,
      message: "malformed daily instruction",
    });
  });

  it("dailyInstruction returns pay with a non-empty messageId", async () => {
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async () =>
        new Response(
          JSON.stringify({
            action: "pay",
            amountUsd: 1.5,
            comment: "daily",
            messageId: "not-a-uuid-but-kept",
          }),
          { status: 200 },
        ),
    );
    await expect(api.dailyInstruction("a@b.com")).resolves.toEqual({
      action: "pay",
      amountUsd: 1.5,
      comment: "daily",
      messageId: "not-a-uuid-but-kept",
    });
  });

  it("dailyInstruction returns pay without messageId", async () => {
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async () =>
        new Response(
          JSON.stringify({ action: "pay", amountUsd: 1, comment: "daily" }),
          {
            status: 200,
          },
        ),
    );
    const result = await api.dailyInstruction("a@b.com");
    expect(result).toEqual({ action: "pay", amountUsd: 1, comment: "daily" });
    expect(result).not.toHaveProperty("messageId");
  });

  it("dailyInstruction omits messageId when it is empty", async () => {
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async () =>
        new Response(
          JSON.stringify({
            action: "pay",
            amountUsd: 1,
            comment: "daily",
            messageId: "",
          }),
          { status: 200 },
        ),
    );
    const result = await api.dailyInstruction("a@b.com");
    expect(result).toEqual({ action: "pay", amountUsd: 1, comment: "daily" });
    expect(result).not.toHaveProperty("messageId");
  });

  it("dailyInstruction rejects a malformed action", async () => {
    const payloads: unknown[] = [
      {},
      { action: "hold" },
      { action: "Skip", reason: "no_passkey" },
      { action: 1 },
    ];
    for (const payload of payloads) {
      const api = new GiftsApi(
        "https://api.21.gifts",
        "tok",
        async () => new Response(JSON.stringify(payload), { status: 200 }),
      );
      await expect(api.dailyInstruction("a@b.com")).rejects.toMatchObject({
        status: 0,
        message: "malformed daily instruction",
      });
    }
  });

  it("dailyInstruction rejects a non-finite or non-positive amountUsd", async () => {
    const amounts: unknown[] = [0, -1, NaN, Infinity, "1", null];
    for (const amountUsd of amounts) {
      const api = new GiftsApi(
        "https://api.21.gifts",
        "tok",
        async () =>
          new Response(
            JSON.stringify({ action: "pay", amountUsd, comment: "daily" }),
            {
              status: 200,
            },
          ),
      );
      await expect(api.dailyInstruction("a@b.com")).rejects.toMatchObject({
        status: 0,
        message: "malformed daily instruction",
      });
    }
  });

  it("dailyInstruction rejects a non-string comment", async () => {
    const comments: unknown[] = [1, null, undefined, true, {}];
    for (const comment of comments) {
      const api = new GiftsApi(
        "https://api.21.gifts",
        "tok",
        async () =>
          new Response(
            JSON.stringify({ action: "pay", amountUsd: 1, comment }),
            { status: 200 },
          ),
      );
      await expect(api.dailyInstruction("a@b.com")).rejects.toMatchObject({
        status: 0,
        message: "malformed daily instruction",
      });
    }
  });

  it("dailyInstruction rejects a non-string messageId", async () => {
    const ids: unknown[] = [1, null, true, {}];
    for (const messageId of ids) {
      const api = new GiftsApi(
        "https://api.21.gifts",
        "tok",
        async () =>
          new Response(
            JSON.stringify({
              action: "pay",
              amountUsd: 1,
              comment: "daily",
              messageId,
            }),
            { status: 200 },
          ),
      );
      await expect(api.dailyInstruction("a@b.com")).rejects.toMatchObject({
        status: 0,
        message: "malformed daily instruction",
      });
    }
  });

  it("dailyInstruction throws on 503", async () => {
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async () =>
        new Response(
          JSON.stringify({ error: "Daily roster is not configured" }),
          { status: 503 },
        ),
    );
    await expect(api.dailyInstruction("a@b.com")).rejects.toMatchObject({
      status: 503,
    });
  });

  it("dailyInstruction maps network failure to status 0", async () => {
    const api = new GiftsApi("https://api.21.gifts", "tok", async () => {
      throw new Error("offline");
    });
    await expect(api.dailyInstruction("a@b.com")).rejects.toMatchObject({
      status: 0,
    });
  });
});

const IMPORT_BODY = {
  comment: "21gifts daily",
  paymentsEnabled: true,
  moderatorPaymentsEnabled: true,
  recipients: [{ address: "a@b.com", amountUsd: 1 }],
  moderators: [] as Array<{ address: string; amountUsd: number }>,
};

function fullDocument(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    comment: "21gifts daily",
    paymentsEnabled: true,
    moderatorPaymentsEnabled: true,
    defaultAmountUsd: 1,
    recipients: [{ address: "a@b.com", amountUsd: 1 }],
    moderators: [],
    ...overrides,
  };
}

describe("GiftsApi roster", () => {
  it("importRosterDocument posts the file fields without defaultAmountUsd", async () => {
    let seenUrl = "";
    let sent: unknown;
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async (url, init) => {
        seenUrl = String(url);
        sent = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify(fullDocument()), { status: 200 });
      },
    );
    await expect(api.importRosterDocument(IMPORT_BODY)).resolves.toEqual(
      fullDocument(),
    );
    expect(seenUrl).toBe("https://api.21.gifts/funding/daily-roster/document");
    expect(sent).toEqual(IMPORT_BODY);
    expect(sent).not.toHaveProperty("defaultAmountUsd");
  });

  it("worker methods post to the matching paths and return the document", async () => {
    const cases: Array<{
      run: (api: GiftsApi) => Promise<unknown>;
      path: string;
      body: unknown;
    }> = [
      {
        run: (api) => api.setRosterComment("hello"),
        path: "/funding/daily-roster/worker/comment",
        body: { comment: "hello" },
      },
      {
        run: (api) => api.setRosterPayments(false),
        path: "/funding/daily-roster/worker/payments",
        body: { enabled: false },
      },
      {
        run: (api) => api.addRosterRecipient("b@b.com", 2),
        path: "/funding/daily-roster/worker/recipients",
        body: { address: "b@b.com", amountUsd: 2 },
      },
      {
        run: (api) => api.updateRosterRecipient("a@b.com", 3),
        path: "/funding/daily-roster/worker/recipients/update",
        body: { address: "a@b.com", amountUsd: 3 },
      },
      {
        run: (api) => api.deleteRosterRecipient("a@b.com"),
        path: "/funding/daily-roster/worker/recipients/delete",
        body: { address: "a@b.com" },
      },
      {
        run: (api) => api.addRosterModerator("m@b.com", 4),
        path: "/funding/daily-roster/worker/moderators",
        body: { address: "m@b.com", amountUsd: 4 },
      },
      {
        run: (api) => api.updateRosterModerator("m@b.com", 5),
        path: "/funding/daily-roster/worker/moderators/update",
        body: { address: "m@b.com", amountUsd: 5 },
      },
      {
        run: (api) => api.deleteRosterModerator("m@b.com"),
        path: "/funding/daily-roster/worker/moderators/delete",
        body: { address: "m@b.com" },
      },
      {
        run: (api) => api.setRosterModeratorPayments(false),
        path: "/funding/daily-roster/worker/moderators/payments",
        body: { enabled: false },
      },
    ];
    for (const row of cases) {
      let seenUrl = "";
      let sent: unknown;
      const api = new GiftsApi(
        "https://api.21.gifts",
        "tok",
        async (url, init) => {
          seenUrl = String(url);
          sent = JSON.parse(String(init?.body ?? "{}"));
          return new Response(JSON.stringify(fullDocument()), { status: 200 });
        },
      );
      await expect(row.run(api)).resolves.toEqual(fullDocument());
      expect(seenUrl).toBe(`https://api.21.gifts${row.path}`);
      expect(sent).toEqual(row.body);
    }
  });

  it("import then worker round-trip uses the shared stand-in", async () => {
    const api = new GiftsApi("https://api.21.gifts", "tok", withRosterApi());
    const imported = await api.importRosterDocument(IMPORT_BODY);
    expect(imported.defaultAmountUsd).toBe(1);
    expect(imported.moderatorPaymentsEnabled).toBe(true);
    const added = await api.addRosterRecipient("b@b.com", 2);
    expect(added.recipients).toEqual([
      { address: "a@b.com", amountUsd: 1 },
      { address: "b@b.com", amountUsd: 2 },
    ]);
    const second = await api.importRosterDocument({
      ...IMPORT_BODY,
      recipients: [{ address: "other@b.com", amountUsd: 9 }],
    });
    expect(second.recipients).toEqual(added.recipients);
  });

  it("rejects a malformed roster document as status 0", async () => {
    const payloads: unknown[] = [
      {},
      {
        comment: 1,
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: 1,
        recipients: [],
        moderators: [],
      },
      {
        comment: "x",
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        recipients: [],
        moderators: [],
      },
      {
        comment: "x",
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: "1",
        recipients: [],
        moderators: [],
      },
      {
        comment: "x",
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: Number.NaN,
        recipients: [],
        moderators: [],
      },
      {
        comment: "x",
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: 1,
        recipients: {},
        moderators: [],
      },
      {
        comment: "x",
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: 1,
        recipients: [],
        moderators: {},
      },
      {
        comment: "x",
        paymentsEnabled: "yes",
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: 1,
        recipients: [],
        moderators: [],
      },
      {
        comment: "x",
        paymentsEnabled: true,
        moderatorPaymentsEnabled: "yes",
        defaultAmountUsd: 1,
        recipients: [],
        moderators: [],
      },
      {
        comment: "x",
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: 1,
        recipients: [null],
        moderators: [],
      },
      {
        comment: "x",
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: 1,
        recipients: [[]],
        moderators: [],
      },
      {
        comment: "x",
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: Infinity,
        recipients: [],
        moderators: [],
      },
      {
        comment: "x",
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: 1,
        recipients: [{ address: "a@b.com", amountUsd: 0 }],
        moderators: [],
      },
      {
        comment: "x",
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: 1,
        recipients: [{ address: 1, amountUsd: 1 }],
        moderators: [],
      },
      {
        comment: "x",
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: 1,
        recipients: [],
        moderators: [{ address: "a@b.com" }],
      },
    ];
    for (const payload of payloads) {
      const api = new GiftsApi(
        "https://api.21.gifts",
        "tok",
        async () => new Response(JSON.stringify(payload), { status: 200 }),
      );
      await expect(api.importRosterDocument(IMPORT_BODY)).rejects.toMatchObject(
        {
          status: 0,
          message: "malformed roster",
        },
      );
    }
  });

  it("rejects a JSON array roster as malformed", async () => {
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async () => new Response(JSON.stringify([]), { status: 200 }),
    );
    await expect(api.importRosterDocument(IMPORT_BODY)).rejects.toMatchObject({
      status: 0,
      message: "malformed roster",
    });
  });

  it("keeps HTTP 400 from a worker as GiftsApiError", async () => {
    const api = new GiftsApi(
      "https://api.21.gifts",
      "tok",
      async () =>
        new Response(JSON.stringify({ error: "Invalid comment" }), {
          status: 400,
        }),
    );
    await expect(api.setRosterComment("x")).rejects.toMatchObject({
      status: 400,
      message: "Invalid comment",
    });
  });
});
