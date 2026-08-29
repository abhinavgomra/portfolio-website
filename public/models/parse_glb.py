import struct
import json

with open("character_decrypted.glb", "rb") as f:
    magic = f.read(4)
    version = struct.unpack("<I", f.read(4))[0]
    length = struct.unpack("<I", f.read(4))[0]
    chunk_length = struct.unpack("<I", f.read(4))[0]
    chunk_type = f.read(4)
    json_content = f.read(chunk_length).decode('utf-8', errors='ignore')
    gltf = json.loads(json_content)
    
    print("--- Nodes ---")
    for node in gltf.get("nodes", []):
        if "name" in node:
            print(f"Node: {node['name']}")
            
    print("\n--- Meshes ---")
    for mesh in gltf.get("meshes", []):
        if "name" in mesh:
            print(f"Mesh: {mesh['name']}")
            
    print("\n--- Materials ---")
    for material in gltf.get("materials", []):
        if "name" in material:
            print(f"Material: {material['name']}")
