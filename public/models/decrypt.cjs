const crypto = require("crypto");
const fs = require("fs");

const decryptFile = (inputFile, outputFile, password) => {
  const key = crypto.createHash("sha256").update(password).digest();
  const fileBuffer = fs.readFileSync(inputFile);
  const iv = fileBuffer.slice(0, 16);
  const data = fileBuffer.slice(16);

  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  fs.writeFileSync(outputFile, decrypted);
};

decryptFile("character.enc", "character_decrypted.glb", "Character3D#@");
console.log("Decrypted successfully to character_decrypted.glb");
