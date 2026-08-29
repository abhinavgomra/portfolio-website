import * as THREE from "three";
import { DRACOLoader, GLTF, GLTFLoader } from "three-stdlib";
import { setCharTimeline, setAllTimeline } from "../../utils/GsapScroll";
import { decryptFile } from "./decrypt";

/**
 * Megumi-inspired palette: restrained, natural, and intentionally matte.
 * Eye textures are preserved; no eye-colour conversion is performed.
 */
const APPEARANCE = {
  skin: 0xdba876,
  lips: 0xd9938d,
  hair: 0x141822,
  eyebrow: 0x2a1d13,
  stubble: 0x2b2018,
  shirt: 0x121212,
  pant: 0x1b1b1b,
  shoe: 0x111111,
} as const;

const MODEL_URL = "/models/character.enc";
const MODEL_PASSWORD = "Character3D#@";
const DRACO_PATH = "/draco/";
const FOOT_Y = 3.36;
const CUSTOMIZED_MARK = "character-style-v3";

const hasPartName = (object: THREE.Object3D, ...targets: string[]): boolean => {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    const name = current.name.toLowerCase();
    if (targets.some((target) => name.includes(target))) return true;
  }
  return false;
};

const findParts = (root: THREE.Object3D, ...targets: string[]): THREE.Object3D[] => {
  const matches: THREE.Object3D[] = [];
  root.traverse((object) => {
    if (hasPartName(object, ...targets) && object.name.toLowerCase().includes(targets[0])) {
      matches.push(object);
    }
  });
  return matches;
};

const isFaceMesh = (mesh: THREE.Mesh): boolean =>
  mesh.name === "Plane.007" || hasPartName(mesh, "face", "head");

const smoothBand = (value: number, low: number, high: number, feather: number): number => {
  const rise = THREE.MathUtils.smoothstep(value, low - feather, low + feather);
  const fall = 1 - THREE.MathUtils.smoothstep(value, high - feather, high + feather);
  return THREE.MathUtils.clamp(Math.min(rise, fall), 0, 1);
};

const fadeOut = (value: number, high: number, feather: number): number =>
  THREE.MathUtils.clamp(
    1 - THREE.MathUtils.smoothstep(value, high - feather, high + feather),
    0,
    1,
  );

/**
 * Recolours only saturated mid-tone pixels, which normally correspond to the
 * iris. Whites, pupils, and catch-lights remain untouched. The source texture
 * is never mutated, so repeated customization is safe.
 */
const recolorIrisLightBrown = (texture: THREE.Texture): THREE.Texture => {
  const image = texture.image as
    | HTMLImageElement
    | HTMLCanvasElement
    | ImageBitmap
    | undefined;
  if (!image || !("width" in image) || !image.width || !("height" in image)) return texture;

  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) return texture;

  context.drawImage(image as CanvasImageSource, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  const iris = { r: 142, g: 103, b: 58 }; // natural light brown

  for (let i = 0; i < data.length; i += 4) {
    const red = data[i];
    const green = data[i + 1];
    const blue = data[i + 2];
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;

    // Avoid recolouring the white sclera, dark pupil, and near-white highlights.
    const warmBrownPixel = red > green + 8 && green > blue + 4;
    if (warmBrownPixel && saturation > 0.12 && maximum > 38 && maximum < 225) {
      const brightness = maximum / 255;
      const amount = 0.38 + brightness * 0.72;
      data[i] = Math.min(255, iris.r * amount);
      data[i + 1] = Math.min(255, iris.g * amount);
      data[i + 2] = Math.min(255, iris.b * amount);
    }
  }

  context.putImageData(pixels, 0, 0);
  const recoloured = new THREE.CanvasTexture(canvas);
  recoloured.colorSpace = texture.colorSpace;
  recoloured.flipY = texture.flipY;
  recoloured.wrapS = texture.wrapS;
  recoloured.wrapT = texture.wrapT;
  recoloured.needsUpdate = true;
  return recoloured;
};

/** Clone before vertex edits so shared GLTF geometry is never corrupted. */
const cloneGeometryForEdit = (mesh: THREE.Mesh): THREE.BufferGeometry => {
  const geometry = mesh.geometry.clone();
  mesh.geometry = geometry;
  return geometry;
};

/** A subtle silhouette adjustment; deliberately avoids random/frizz displacement. */
const shapeHair = (mesh: THREE.Mesh): void => {
  const geometry = cloneGeometryForEdit(mesh);
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  if (!positions || !normals) return;

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return;

  const height = Math.max(box.max.y - box.min.y, 0.001);
  const depth = Math.max(box.max.z - box.min.z, 0.001);
  const halfWidth = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), 0.001);

  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    const t = THREE.MathUtils.clamp((y - box.min.y) / height, 0, 1);
    const side = Math.abs(x) / halfWidth;

    // Slight crown volume and a restrained asymmetrical fringe.
    const crown = THREE.MathUtils.smoothstep(t, 0.56, 0.96);
    const fringe =
      t > 0.42 && t < 0.88 && z > box.min.z + depth * 0.62
        ? THREE.MathUtils.smoothstep((z - box.min.z) / depth, 0.62, 1)
        : 0;
    const sideLift =
      t < 0.56 && side > 0.42
        ? THREE.MathUtils.smoothstep(0.56 - t, 0, 0.5) *
          THREE.MathUtils.smoothstep(side, 0.42, 0.95)
        : 0;

    const nx = normals.getX(i);
    const ny = normals.getY(i);
    const nz = normals.getZ(i);
    const fringeBias = x > 0 ? 1.15 : 0.9;

    positions.setXYZ(
      i,
      x + nx * crown * halfWidth * 0.035 - x * sideLift * 0.16,
      y + ny * crown * height * 0.025 + sideLift * height * 0.18 - fringe * height * 0.045 * fringeBias,
      z + nz * crown * depth * 0.03 + fringe * depth * 0.018,
    );
  }

  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
};

const shapeFace = (mesh: THREE.Mesh): void => {
  const geometry = cloneGeometryForEdit(mesh);
  const positions = geometry.getAttribute("position");
  if (!positions) return;

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return;

  const height = Math.max(box.max.y - box.min.y, 0.001);
  const halfWidth = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), 0.001);

  for (let i = 0; i < positions.count; i += 1) {
    let x = positions.getX(i);
    let y = positions.getY(i);
    let z = positions.getZ(i);
    const t = THREE.MathUtils.clamp((y - box.min.y) / height, 0, 1);
    const side = Math.abs(x) / halfWidth;

    // Anime-inspired structure: fuller cheekbones, a slimmer lower face, and
    // a defined chin. Values stay deliberately small to avoid mesh artifacts.
    if (t < 0.36) {
      const taper = THREE.MathUtils.smoothstep(t, 0.36, 0.06);
      x *= 1 - taper * 0.18;
      z += taper * height * 0.006;
    }
    if (t > 0.39 && t < 0.66 && side > 0.3 && side < 0.8) x *= 1.025;
    if (t > 0.24 && t < 0.34 && side > 0.35 && side < 0.62) x *= 1.022;
    if (t > 0.76 && t < 0.91 && side > 0.45) z += height * 0.005;
    if (t < 0.16 && side < 0.24) {
      // Small forward chin plane for a cleaner jaw-to-chin transition.
      z += height * 0.012;
      y -= height * 0.003;
    }

    positions.setXYZ(i, x, y, z);
  }

  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
};

const applyFaceColors = (
  mesh: THREE.Mesh,
  material: THREE.MeshStandardMaterial,
): void => {
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute("position");
  if (!positions) return;

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return;

  const height = Math.max(box.max.y - box.min.y, 0.001);
  const depth = Math.max(box.max.z - box.min.z, 0.001);
  const halfWidth = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), 0.001);
  const skin = new THREE.Color(APPEARANCE.skin);
  const lips = new THREE.Color(APPEARANCE.lips);
  const stubble = new THREE.Color(APPEARANCE.stubble);
  const colors = new Float32Array(positions.count * 3);
  const color = new THREE.Color();

  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    const t = (y - box.min.y) / height;
    const zt = (z - box.min.z) / depth;
    const side = Math.abs(x) / halfWidth;

    color.copy(skin);
    // A broader, softer lip mask keeps the mouth visible on varied face meshes.
    if (t > 0.17 && t < 0.34 && side < 0.38 && zt > 0.68) color.lerp(lips, 0.92);

    const front = THREE.MathUtils.smoothstep(zt, 0.55, 0.82);
    const moustache = smoothBand(t, 0.31, 0.365, 0.02) * fadeOut(side, 0.24, 0.07) * front * 0.22;
    const goatee = smoothBand(t, 0.075, 0.15, 0.03) * fadeOut(side, 0.1, 0.05) * front * 0.15;
    const jaw = smoothBand(t, 0.04, 0.2, 0.05) * smoothBand(side, 0.2, 0.58, 0.09) * front * 0.06;
    color.lerp(stubble, Math.max(moustache, goatee, jaw));

    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  material.vertexColors = true;
  material.color.set(0xffffff);
  material.map = null;
  material.metalness = 0;
  material.roughness = 0.55;
  material.envMapIntensity = 0;
};

const setSkinMaterial = (material: THREE.MeshStandardMaterial): void => {
  material.vertexColors = false;
  material.color.setHex(APPEARANCE.skin);
  material.roughness = 0.52;
  material.metalness = 0;
  material.envMapIntensity = 0;
};

const styleMesh = (
  mesh: THREE.Mesh,
  material: THREE.MeshStandardMaterial,
  originalMap: THREE.Texture | null,
): void => {
  if (hasPartName(mesh, "hair")) {
    material.color.setHex(APPEARANCE.hair);
    material.roughness = 0.9;
    shapeHair(mesh);
    mesh.renderOrder = 10;
    return;
  }
  if (hasPartName(mesh, "eyebrow")) {
    material.color.setHex(APPEARANCE.eyebrow);
    material.roughness = 0.85;
    return;
  }
  if (hasPartName(mesh, "eye")) {
    // Preserve the eye texture structure while changing only iris pixels.
    material.color.set(0xffffff);
    material.vertexColors = false;
    material.map = originalMap ? recolorIrisLightBrown(originalMap) : null;
    material.roughness = 0.32;
    material.metalness = 0;
    material.envMapIntensity = 0;
    // Let the eyelid/face depth layer occlude the eye rim naturally. Forcing
    // eyes to render in front creates the dark lower-eyelid strip seen in the
    // render, so eye meshes use normal depth testing and write depth normally.
    material.polygonOffset = false;
    material.depthTest = true;
    material.depthWrite = true;
    mesh.renderOrder = 0;
    return;
  }
  if (hasPartName(mesh, "ear", "nose", "neck", "hand")) {
    setSkinMaterial(material);
    return;
  }
  if (hasPartName(mesh, "shirt")) {
    material.color.setHex(APPEARANCE.shirt);
    material.roughness = 0.88;
    return;
  }
  if (hasPartName(mesh, "pant")) {
    material.color.setHex(APPEARANCE.pant);
    material.roughness = 0.8;
    return;
  }
  if (hasPartName(mesh, "shoe")) {
    material.color.setHex(APPEARANCE.shoe);
    material.roughness = 0.7;
    return;
  }

  setSkinMaterial(material);
  if (isFaceMesh(mesh)) {
    shapeFace(mesh);
    applyFaceColors(mesh, material);
  }
};

const customizeCharacter = (character: THREE.Object3D): void => {
  // Prevent cumulative scale/deformation if a timeline or hot reload invokes
  // customization more than once for the same scene.
  if (character.userData[CUSTOMIZED_MARK]) return;
  character.userData[CUSTOMIZED_MARK] = true;

  character.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.material) return;

    child.castShadow = false;
    child.receiveShadow = false;
    child.frustumCulled = true;

    const materials = (Array.isArray(child.material) ? child.material : [child.material]) as THREE.MeshStandardMaterial[];
    const originalMaps = materials.map((material) => material.map ?? null);
    const clonedMaterials = materials.map((material) => {
      const clone = material.clone();
      clone.precision = "mediump";
      return clone;
    });

    child.material = Array.isArray(child.material) ? clonedMaterials : clonedMaterials[0];
    styleMesh(child, clonedMaterials[0], originalMaps[0]);

    // Keep multi-material submeshes visually consistent without extra styling passes.
    for (let i = 1; i < clonedMaterials.length; i += 1) {
      clonedMaterials[i].color.copy(clonedMaterials[0].color);
      clonedMaterials[i].roughness = clonedMaterials[0].roughness;
      clonedMaterials[i].metalness = clonedMaterials[0].metalness;
      clonedMaterials[i].envMapIntensity = clonedMaterials[0].envMapIntensity;
      clonedMaterials[i].vertexColors = clonedMaterials[0].vertexColors;
      clonedMaterials[i].map = hasPartName(child, "eye")
        ? originalMaps[i]
          ? recolorIrisLightBrown(originalMaps[i]!)
          : null
        : originalMaps[i] ?? clonedMaterials[0].map;
      if (hasPartName(child, "eye")) {
        clonedMaterials[i].polygonOffset = false;
        clonedMaterials[i].depthTest = true;
        clonedMaterials[i].depthWrite = true;
      }
    }
  });

  // Fuller, loose fringe inspired by the reference without over-scaling the head.
  character.getObjectByName("hair")?.scale.multiplyScalar(1.06);

  const ears = findParts(character, "ear");
  for (const ear of ears) {
    // Flatten and reduce both ears while keeping their original orientation.
    ear.scale.set(ear.scale.x * 0.78, ear.scale.y * 0.82, ear.scale.z * 0.78);
    ear.position.z -= 0.008;
  }

  const eyes = character.getObjectByName("EYEs.001");
  if (eyes) {
    // Slightly almond-shaped proportions, but not so narrow that the lower
    // eye geometry intersects the face and produces black dots.
    eyes.scale.set(1.06, 0.9, 1.03);
    // Move the eye shells microscopically into the head, behind the eyelids.
    eyes.position.z -= 0.004;
    eyes.position.y += 0.001;
  }

  const eyebrows = character.getObjectByName("Eyebrow");
  if (eyebrows) eyebrows.scale.set(1.22, 0.9, 0.96);
};

const setFootHeight = (character: THREE.Object3D): void => {
  for (const name of ["footR", "footL"]) {
    const foot = character.getObjectByName(name);
    if (foot) foot.position.y = FOOT_Y;
  }
};

const setCharacter = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
) => {
  const loader = new GLTFLoader();
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(DRACO_PATH);
  loader.setDRACOLoader(dracoLoader);

  const loadCharacter = async (): Promise<GLTF> => {
    let blobUrl: string | undefined;

    try {
      const encryptedBlob = await decryptFile(MODEL_URL, MODEL_PASSWORD);
      blobUrl = URL.createObjectURL(new Blob([encryptedBlob]));
      const gltf = await loader.loadAsync(blobUrl);
      const character = gltf.scene;

      // Style before compiling so the renderer compiles the final materials/geometries.
      customizeCharacter(character);
      setFootHeight(character);
      await renderer.compileAsync(character, camera, scene);

      setCharTimeline(character, camera);
      setAllTimeline();
      return gltf;
    } finally {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      dracoLoader.dispose();
    }
  };

  return { loadCharacter };
};

export default setCharacter;
