// script_3d.js 文件顶部
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.150.0/build/three.module.js';
import { FBXLoader } from './FBXLoader.module.js'; // 确保这个路径和您保存的文件名一致

const videoElement = document.getElementById('webcamVideo');
const statusElement = document.getElementById('status');
const canvasContainer = document.getElementById('canvasContainer');

let detector; // TensorFlow.js pose detector
let characterModel, characterBones = {}, initialBoneData = {}; // Three.js model and bone data
let scene, camera, renderer, clock; // Three.js essentials
let videoAspectRatio = 4 / 3; // Default, will be updated
let rafId; // requestAnimationFrame ID

// --- Configuration ---
const MODEL_PATH = 'boneMapping.fbx'; // YOUR FBX FILE
const VIDEO_WIDTH = 640; // Resolution for pose detection
const VIDEO_HEIGHT = 480;

// Default bone axis (the axis that points "along" the bone's length in its local space)
// This is a GUESS. For Mixamo models, it's often Y-up for the model, bones might point along X or Y.
// You might need to experiment: new THREE.Vector3(1,0,0), new THREE.Vector3(0,1,0), or new THREE.Vector3(0,0,1)
const BONE_PRIMARY_AXIS = new THREE.Vector3(0, 1, 0); // Assumes Y-axis points along the bone length
const BONE_UP_AXIS = new THREE.Vector3(0, 0, 1);      // Assumes Z-axis is the "up" for the bone's local space when orienting

// ***** CRUCIAL: BONE MAPPING *****
// YOU MUST UPDATE THESE STRING VALUES TO YOUR FBX MODEL'S ACTUAL BONE NAMES.
// Use the console output "Discovered bones:" to find the correct names.
const boneMapping = {
    // MoveNet Keypoint : Your FBX Bone Name
    'hips': 'mixamorig_Hips', // A central bone, often good as a root for relative movements
    'left_hip': 'mixamorig_LeftUpLeg',
    'left_knee': 'mixamorig_LeftLeg',
    'left_ankle': 'mixamorig_LeftFoot',
    'right_hip': 'mixamorig_RightUpLeg',
    'right_knee': 'mixamorig_RightLeg',
    'right_ankle': 'mixamorig_RightFoot',
    'left_shoulder': 'mixamorig_LeftShoulder', // This might be a clavicle in some rigs
    'left_arm': 'mixamorig_LeftArm',        // Upper arm bone
    'left_elbow': 'mixamorig_LeftForeArm',   // Forearm bone
    'left_wrist': 'mixamorig_LeftHand',
    'right_shoulder': 'mixamorig_RightShoulder',// Clavicle
    'right_arm': 'mixamorig_RightArm',       // Upper arm
    'right_elbow': 'mixamorig_RightForeArm',  // Forearm
    'right_wrist': 'mixamorig_RightHand',
    'neck': 'mixamorig_Neck',
    'head': 'mixamorig_Head' // Often controlled by 'nose' or average of eye keypoints
};


// --- Three.js Initialization ---
function initThree() {
    statusElement.textContent = '初始化3D场景...';
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x333842);
    clock = new THREE.Clock();

    const containerRect = canvasContainer.getBoundingClientRect();
    camera = new THREE.PerspectiveCamera(50, containerRect.width / containerRect.height, 0.1, 1000);
    camera.position.set(0, 1.5, 2.5); // Adjust camera position to view your model well
    camera.lookAt(0, 1, 0); // Look at a point slightly above the origin

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(containerRect.width, containerRect.height);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    canvasContainer.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(3, 10, 5);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 1024;
    directionalLight.shadow.mapSize.height = 1024;
    scene.add(directionalLight);

    // Ground plane
    const groundGeo = new THREE.PlaneGeometry(20, 20);
    const groundMat = new THREE.MeshPhongMaterial({ color: 0x444444, depthWrite: false });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Optional: OrbitControls for debugging
    // const controls = new THREE.OrbitControls(camera, renderer.domElement);
    // controls.target.set(0, 1, 0); // Adjust target to your model's typical height
    // controls.update();

    statusElement.textContent = '3D场景初始化完毕。';
    window.addEventListener('resize', onWindowResize); // Handle window resize
}

function onWindowResize() {
    const containerRect = canvasContainer.getBoundingClientRect();
    camera.aspect = containerRect.width / containerRect.height;
    camera.updateProjectionMatrix();
    renderer.setSize(containerRect.width, containerRect.height);
}

// --- Load FBX Model ---
async function loadFBXModel(path) {
    statusElement.textContent = '正在加载3D模型 (' + path + ')...';
    const loader = new THREE.FBXLoader();
    return new Promise((resolve, reject) => {
        loader.load(path, (fbx) => {
            characterModel = fbx;
            // --- Adjust model scale and position as needed ---
            characterModel.scale.set(0.01, 0.01, 0.01); // Example: if model is huge
            characterModel.position.set(0, 0, 0);     // Example: center at origin's base

            console.log("FBX Model loaded:", characterModel);

            characterModel.traverse(function (child) {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                    // Optional: Ensure materials are not overly shiny or basic
                    if (child.material) {
                        if (Array.isArray(child.material)) {
                            child.material.forEach(m => { if(m.isMeshStandardMaterial) m.metalness = 0.3; });
                        } else if (child.material.isMeshStandardMaterial) {
                            child.material.metalness = 0.3;
                        }
                    }
                }
                if (child.isBone) {
                    characterBones[child.name] = child;
                    // Store initial rotation (quaternion) and world matrix for calculations
                    initialBoneData[child.name] = {
                        initialQuaternion: child.quaternion.clone(),
                        // bindMatrix: child.matrixWorld.clone() // More advanced: for true retargeting
                    };
                }
            });

            console.log("Discovered bones:", Object.keys(characterBones));
            if (Object.keys(characterBones).length === 0) {
                const msg = "警告: 模型中未找到骨骼！请确保FBX文件已绑定骨骼。动画将无法进行。";
                console.warn(msg);
                statusElement.textContent = msg;
                // reject(new Error(msg)); return; // Or stop further execution
            } else {
                 // Verify boneMapping
                let allMappedBonesFound = true;
                for (const key in boneMapping) {
                    if (boneMapping[key] && !characterBones[boneMapping[key]]) {
                        console.warn(`映射警告: FBX模型中未找到骨骼 '${boneMapping[key]}' (对应关键点 '${key}')`);
                        allMappedBonesFound = false;
                    }
                }
                if (!allMappedBonesFound) {
                    statusElement.textContent = "警告: 部分骨骼映射名在模型中未找到，请检查控制台和boneMapping对象。";
                } else {
                     statusElement.textContent = '3D模型加载完毕并已解析骨骼。';
                }
            }
            scene.add(characterModel);
            resolve(fbx);
        },
        (xhr) => { // Progress callback
            const progress = (xhr.loaded / xhr.total) * 100;
            statusElement.textContent = `正在加载3D模型: ${Math.round(progress)}%`;
        },
        (error) => {
            console.error("FBX加载错误:", error);
            statusElement.textContent = 'FBX模型加载失败。请检查文件路径和控制台错误。';
            reject(error);
        });
    });
}

// --- Webcam and Pose Detection Setup ---
async function setupWebcam() {
    statusElement.textContent = '正在请求摄像头权限...';
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
            audio: false
        });
        videoElement.srcObject = stream;
        return new Promise((resolve) => {
            videoElement.onloadedmetadata = () => {
                videoElement.play();
                videoAspectRatio = videoElement.videoWidth / videoElement.videoHeight;
                statusElement.textContent = '摄像头已准备。';
                resolve(videoElement);
            };
        });
    } catch (e) {
        console.error('获取摄像头权限失败:', e);
        statusElement.textContent = '获取摄像头权限失败。请检查设置并刷新页面。';
        alert('摄像头访问被拒绝或不可用。');
        throw e;
    }
}

async function loadPoseDetector() {
    statusElement.textContent = '正在加载姿态识别模型...';
    await tf.setBackend('wasm'); // Using WebAssembly for performance
    await tf.ready();
    const model = poseDetection.SupportedModels.MoveNet;
    // SINGLEPOSE_LIGHTNING is faster, THUNDER is more accurate
    detector = await poseDetection.createDetector(model, { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING });
    statusElement.textContent = '姿态模型加载完毕。';
}


// --- Pose to 3D Model Animation ---
function getScreenKeypoint(name, keypointsMap, isMirrored = true) {
    const kp = keypointsMap.get(name);
    if (!kp || kp.score < 0.3) return null; // Confidence threshold

    // Keypoints from MoveNet are for non-mirrored video.
    // If your videoElement is visually mirrored (transform: scaleX(-1)),
    // then the X-coordinates need to be flipped for correct mapping.
    let x = kp.x;
    if (isMirrored) {
        x = VIDEO_WIDTH - kp.x;
    }
    return new THREE.Vector3(x / VIDEO_WIDTH, 1.0 - (kp.y / VIDEO_HEIGHT), kp.z || 0); // Normalize Z if present
}


// Helper to get a world direction vector from two keypoints
function getDirectionVector(kpName1, kpName2, keypointsMap, poseCenterZ = 0.5) {
    const p1 = keypointsMap.get(kpName1);
    const p2 = keypointsMap.get(kpName2);

    if (!p1 || p1.score < 0.3 || !p2 || p2.score < 0.3) return null;

    // Flip X if video is mirrored for display (assuming keypoints are from original non-mirrored feed)
    const p1x = VIDEO_WIDTH - p1.x;
    const p2x = VIDEO_WIDTH - p2.x;

    // Create pseudo 3D points.
    // This is a simplification: X and Y are scaled from screen, Z is from MoveNet (relative depth)
    // The scaling factors (e.g., 2 for X, 1.5 for Y) are empirical and might need tuning for your scene/model.
    const v1 = new THREE.Vector3(
        (p1x / VIDEO_WIDTH - 0.5) * 2,      // Map to -1 to 1 range, scale for scene width
        (1 - p1.y / VIDEO_HEIGHT - 0.5) * 1.5, // Map to -0.75 to 0.75 for scene height
        (p1.z || 0) * 0.5 + poseCenterZ      // Use MoveNet's Z, scale and offset
    );
    const v2 = new THREE.Vector3(
        (p2x / VIDEO_WIDTH - 0.5) * 2,
        (1 - p2.y / VIDEO_HEIGHT - 0.5) * 1.5,
        (p2.z || 0) * 0.5 + poseCenterZ
    );
    return v2.clone().sub(v1).normalize();
}

// This is the core, complex function. It's simplified.
function updateBoneTransform(bone, targetDirection, initialRotQuat, primaryAxis, upAxis) {
    if (!bone || !targetDirection) return;

    // We want to rotate the bone so its `primaryAxis` (in local space) aligns with `targetDirection` (in world space).
    // 1. Get bone's parent's world-to-local matrix
    const parent = bone.parent;
    const parentWorldInverse = new THREE.Matrix4();
    if (parent) {
        parentWorldInverse.copy(parent.matrixWorld).invert();
    }

    // 2. Transform targetDirection from world to parent's local space
    const localTargetDirection = targetDirection.clone().transformDirection(parentWorldInverse);

    // 3. Calculate rotation from primaryAxis to localTargetDirection
    const rotation = new THREE.Quaternion().setFromUnitVectors(primaryAxis, localTargetDirection);

    // 4. Apply this rotation to the bone's initial (bind pose) quaternion
    bone.quaternion.copy(initialRotQuat).multiply(rotation);
}


function updateCharacterPose(pose) {
    if (!characterModel || Object.keys(characterBones).length === 0 || !pose) return;

    const keypointsMap = new Map(pose.keypoints.map(kp => [kp.name, kp]));

    // Estimate a central Z depth for the pose to offset Z values from MoveNet
    const lh = keypointsMap.get('left_hip');
    const rh = keypointsMap.get('right_hip');
    let poseCenterZ = 0.5; // Default Z offset
    if (lh && rh && lh.score > 0.3 && rh.score > 0.3) {
        poseCenterZ = ((lh.z || 0) + (rh.z || 0)) / 2 * 0.5 + 0.3; // Average hip Z, scale, and offset
    }


    // --- Root bone (Hips) ---
    // For simplicity, let's try to orient the hips bone based on the general torso direction
    // This is very basic and might not look great without a full body IK or more sophisticated approach.
    const hipsBoneName = boneMapping['hips'];
    if (hipsBoneName && characterBones[hipsBoneName]) {
        const ls = keypointsMap.get('left_shoulder');
        const rs = keypointsMap.get('right_shoulder');

        if (ls && rs && lh && rh) {
            const shoulderMidX = VIDEO_WIDTH - (ls.x + rs.x) / 2; // Mirrored X
            const hipMidX = VIDEO_WIDTH - (lh.x + rh.x) / 2;       // Mirrored X
            
            const angle = Math.atan2(
                (1 - (ls.y + rs.y) / 2 / VIDEO_HEIGHT) - (1 - (lh.y + rh.y) / 2 / VIDEO_HEIGHT), // Y diff
                (shoulderMidX / VIDEO_WIDTH) - (hipMidX / VIDEO_WIDTH)  // X diff