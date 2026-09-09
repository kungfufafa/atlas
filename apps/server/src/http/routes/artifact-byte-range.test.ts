import { expect, test } from "bun:test";
import { handleByteRangeRequest } from "./artifact-preview";

const content = Buffer.from("0123456789");

test("malformed range returns a complete response with finite truthful headers", async () => {
  const response = handleByteRangeRequest(
    content,
    "text/plain",
    "bytes=2-x",
    "file.txt"
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Length")).toBe("10");
  expect(response.headers.get("Content-Range")).toBeNull();
  expect(await response.text()).toBe("0123456789");
});

test("suffix range returns the final bytes", async () => {
  const response = handleByteRangeRequest(
    content,
    "text/plain",
    "bytes=-3",
    "file.txt"
  );
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Length")).toBe("3");
  expect(response.headers.get("Content-Range")).toBe("bytes 7-9/10");
  expect(await response.text()).toBe("789");
});

test.each([
  ["bytes=0-0", "0", "bytes 0-0/10"],
  ["bytes=2-5", "2345", "bytes 2-5/10"],
  ["bytes=2-", "23456789", "bytes 2-9/10"],
  ["bytes=8-99", "89", "bytes 8-9/10"],
  ["bytes=-99", "0123456789", "bytes 0-9/10"],
  ["bytes=0002-0005", "2345", "bytes 2-5/10"],
  ["BYTES=2-5", "2345", "bytes 2-5/10"],
  ["bytes= 2-5 ", "2345", "bytes 2-5/10"],
  [`bytes=2-${"9".repeat(400)}`, "23456789", "bytes 2-9/10"],
  [`bytes=-${"9".repeat(400)}`, "0123456789", "bytes 0-9/10"],
])(
  "single range %s preserves exact response bytes",
  async (range, expected, contentRange) => {
    const response = handleByteRangeRequest(
      content,
      "text/plain",
      range,
      "file.txt",
      true
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Length")).toBe(
      String(expected.length)
    );
    expect(response.headers.get("Content-Range")).toBe(contentRange);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(response.headers.get("Content-Disposition")).toContain("inline");
    expect(await response.text()).toBe(expected);
  }
);

test.each([
  undefined,
  "",
  "items=1-2",
  "bytes=-",
  "bytes=5-2",
  "bytes=2-5x",
  "bytes=+2-5",
  "bytes=2.5-6",
  "bytes=2--5",
  "bytes=0-1,8-9",
  `bytes=${"9".repeat(9000)}-`,
])("unsupported or invalid range %s is ignored", async (range) => {
  const response = handleByteRangeRequest(
    content,
    "text/plain",
    range,
    "file.txt"
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Length")).toBe("10");
  expect(response.headers.get("Content-Range")).toBeNull();
  expect(await response.text()).toBe("0123456789");
});

test.each([
  "bytes=10-",
  "bytes=99-100",
  "bytes=-0",
  `bytes=${"9".repeat(400)}-`,
])("unsatisfiable single range %s returns the known length", async (range) => {
  const response = handleByteRangeRequest(
    content,
    "text/plain",
    range,
    "file.txt"
  );
  expect(response.status).toBe(416);
  expect(response.headers.get("Content-Range")).toBe("bytes */10");
  expect(
    [...response.headers.values()].some(
      (value) => value.includes("NaN") || value.includes("Infinity")
    )
  ).toBe(false);
  expect(await response.text()).not.toBe("0123456789");
});

test.each([undefined, "bytes=0-0", "bytes=-3", "bytes=-0"])(
  "empty content ignores range %s",
  async (range) => {
    const response = handleByteRangeRequest(
      Buffer.alloc(0),
      "text/plain",
      range,
      "empty.txt"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("0");
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(await response.text()).toBe("");
  }
);
