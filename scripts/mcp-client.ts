import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    env: {
      GENERECT_API_BASE: process.env.GENERECT_API_BASE || "https://api.generect.com",
      GENERECT_API_KEY:
        process.env.GENERECT_API_KEY || `Token ${process.argv[2] ?? ""}`,
      GENERECT_TIMEOUT_MS: process.env.GENERECT_TIMEOUT_MS || "60000",
    },
    stderr: "inherit",
  });

  const client = new Client({ name: "local-mcp-client", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools({});
  console.log("Tools:", tools.tools.map((t) => t.name));

  const call = async (name: string, args: any) => {
    try {
      const res = await client.callTool({ name, arguments: args });
      console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`);
      console.log(res);
    } catch (err) {
      console.log(`\n=== ${name}(${JSON.stringify(args)}) ERROR ===`);
      console.error(err);
    }
  };

  // Run quick endpoints first
  await call("get_lead_by_url", {
    url: "https://www.linkedin.com/in/satyanadella/",
  });

  await call("generate_email", {
    first_name: "Satya",
    last_name: "Nadella",
    domain: "microsoft.com",
  });

  await call("search_companies", {
    industries: ["Software Development"],
    headcounts: ["10001+"],
    keywords: ["Microsoft", "Windows", "Azure"],
  });

  await call("search_leads", {
    company_link: "https://www.linkedin.com/company/microsoft/",
    limit: 1,
  });

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});


