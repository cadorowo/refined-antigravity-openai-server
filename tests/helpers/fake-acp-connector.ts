import type { AcpStreamMessage } from "../../src/upstream/refined-antigravity.js";
import type { AcpConnectorFn, JsonRpcId } from "../../src/acp/runtime-types.js";

/**
 * In-memory ACP fake peer for deterministic unit testing.
 * Provides independent read/write channels using Web Streams standard TransformStream.
 */
export class FakeAcpPeer {
  private readonly clientToAgent = new TransformStream<AcpStreamMessage>(
    undefined,
    undefined,
    new CountQueuingStrategy({ highWaterMark: 32 }),
  );
  private readonly agentToClient = new TransformStream<AcpStreamMessage>(
    undefined,
    undefined,
    new CountQueuingStrategy({ highWaterMark: 32 }),
  );
  private readonly agentReader: ReadableStreamDefaultReader<AcpStreamMessage>;
  private readonly agentWriter: WritableStreamDefaultWriter<AcpStreamMessage>;
  private isClosed = false;

  constructor() {
    this.agentReader = this.clientToAgent.readable.getReader();
    this.agentWriter = this.agentToClient.writable.getWriter();
  }

  public getConnector(): AcpConnectorFn {
    return () => ({
      readable: this.agentToClient.readable,
      writable: this.clientToAgent.writable,
    });
  }

  public async readMessage(): Promise<AcpStreamMessage> {
    const { value, done } = await this.agentReader.read();
    if (done || !value) {
      throw new Error("Stream closed while waiting for message from client");
    }
    return value;
  }

  public async writeMessage(message: AcpStreamMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error("Cannot write to closed FakeAcpPeer");
    }
    await this.agentWriter.write(message);
  }

  public async respondSuccess(id: JsonRpcId, result: unknown): Promise<void> {
    await this.writeMessage({
      jsonrpc: "2.0",
      id,
      result,
    } as AcpStreamMessage);
  }

  public async respondError(id: JsonRpcId, code: number, message: string, data?: unknown): Promise<void> {
    await this.writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    } as AcpStreamMessage);
  }

  public async sendNotification(method: string, params: unknown): Promise<void> {
    await this.writeMessage({
      jsonrpc: "2.0",
      method,
      params,
    } as AcpStreamMessage);
  }

  public async sendRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    await this.writeMessage({
      jsonrpc: "2.0",
      id,
      method,
      params,
    } as AcpStreamMessage);
  }

  public async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    try {
      await this.agentReader.cancel();
    } catch {}
    try {
      await this.agentWriter.close();
    } catch {}
  }
}

/**
 * Reads initialize request from client and sends back standard success response.
 */
export async function autoRespondInitialize(peer: FakeAcpPeer, protocolVersion = 1): Promise<AcpStreamMessage> {
  const msg = await peer.readMessage();
  if ("method" in msg && msg.method === "initialize" && "id" in msg && msg.id !== null) {
    await peer.respondSuccess(msg.id, {
      protocolVersion,
      agentCapabilities: {},
      agentInfo: { name: "fake-agent", version: "1.0.0" },
    });
  }
  return msg;
}
