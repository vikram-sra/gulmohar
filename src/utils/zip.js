// A minimal STORED-format (uncompressed) ZIP writer, so "Save" can bundle
// placements.json with the uploaded images without adding a dependency
// (fflate isn't installed, and this editor chunk should stay small since it
// only ever loads for someone who added ?edit). Stored entries need no
// compression codec, just correct headers and a CRC32 -- both implemented
// below, nothing external.

function crc32(bytes) {
    let c, crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        c = (crc ^ bytes[i]) & 0xFF;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
    const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() >> 1) & 0x1F);
    const day = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0xF) << 5) | (date.getDate() & 0x1F);
    return { time, day };
}

/**
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @returns {Blob}
 */
export function writeZip(files) {
    const { time, day } = dosDateTime();
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const { name, data } of files) {
        const nameBytes = encoder.encode(name);
        const crc = crc32(data);

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);           // version needed
        local.setUint16(6, 0, true);            // flags
        local.setUint16(8, 0, true);            // method: 0 = stored
        local.setUint16(10, time, true);
        local.setUint16(12, day, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true); // compressed size
        local.setUint32(22, data.length, true); // uncompressed size
        local.setUint16(26, nameBytes.length, true);
        local.setUint16(28, 0, true);           // extra field length
        localParts.push(new Uint8Array(local.buffer), nameBytes, data);

        const central = new DataView(new ArrayBuffer(46));
        central.setUint32(0, 0x02014b50, true);
        central.setUint16(4, 20, true);         // version made by
        central.setUint16(6, 20, true);         // version needed
        central.setUint16(8, 0, true);
        central.setUint16(10, 0, true);
        central.setUint16(12, time, true);
        central.setUint16(14, day, true);
        central.setUint32(16, crc, true);
        central.setUint32(20, data.length, true);
        central.setUint32(24, data.length, true);
        central.setUint16(28, nameBytes.length, true);
        central.setUint16(30, 0, true);         // extra length
        central.setUint16(32, 0, true);         // comment length
        central.setUint16(34, 0, true);         // disk number
        central.setUint16(36, 0, true);         // internal attrs
        central.setUint32(38, 0, true);         // external attrs
        central.setUint32(42, offset, true);    // local header offset
        centralParts.push(new Uint8Array(central.buffer), nameBytes);

        offset += local.buffer.byteLength + nameBytes.length + data.length;
    }

    const centralStart = offset;
    let centralSize = 0;
    centralParts.forEach((p) => { centralSize += p.length; });

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralStart, true);
    end.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
