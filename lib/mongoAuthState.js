const { initAuthCreds, BufferJSON, proto } = require("@whiskeysockets/baileys");

async function useMongoDBAuthState(collection, sessionId) {
    const writeData = async (data, id) => {
        await collection.updateOne(
            { _id: `${sessionId}:${id}` },
            { $set: { value: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) } },
            { upsert: true }
        );
    };

    const readData = async (id) => {
        const doc = await collection.findOne({ _id: `${sessionId}:${id}` });
        if (!doc) return null;
        try {
            return JSON.parse(JSON.stringify(doc.value), BufferJSON.reviver);
        } catch {
            return doc.value;
        }
    };

    const removeData = async (id) => {
        await collection.deleteOne({ _id: `${sessionId}:${id}` });
    };

    let creds = await readData("creds");
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, "creds");
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === "app-state-sync-key" && value) {
                            try { value = proto.Message.AppStateSyncKeyData.fromObject(value); }
                            catch {}
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, "creds")
    };
}

module.exports = { useMongoDBAuthState };