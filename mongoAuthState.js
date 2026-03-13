const { initAuthCreds, BufferJSON, proto } = require("@whiskeysockets/baileys");

async function useMongoDBAuthState(collection) {
  const writeData = async (data, id) => {
    await collection.updateOne(
      { _id: id },
      { $set: { data: JSON.stringify(data, BufferJSON.replacer) } },
      { upsert: true },
    );
  };

  const readData = async (id) => {
    try {
      const row = await collection.findOne({ _id: id });
      if (!row) return null;
      return JSON.parse(row.data, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = async (id) => {
    await collection.deleteOne({ _id: id });
  };

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const docId = `${category}-${id}`;
              tasks.push(value ? writeData(value, docId) : removeData(docId));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData(creds, "creds");
    },
  };
}

module.exports = { useMongoDBAuthState };
