// script_3d.js

// 1. ES Module Imports (由 index.html 中的 Import Map 解析)
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
// 如果您需要 OrbitControls 或其他 JSM 模块，也在这里导入，例如:
// import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// --- DOM Elements ---
const videoElement = document.getElementById('webcamVideo');
const statusElement = document.getElementById('status');
const canvasContainer = document.getElementById('canvasContainer');

// --- Configuration ---
const MODEL_PATH = 'boneMapping.fbx'; // 您的FBX模型文件路径
const VIDEO_WIDTH = 640; // Pose Detection 使用的分辨率
const VIDEO_HEIGHT = 480;

// 骨骼的局部主轴（指向骨骼长度方向的轴）- 这只是一个猜测，您可能需要调整
const BONE_PRIMARY_AXIS = new THREE.Vector3(0, 1, 0); // 假设Y轴沿骨骼长度方向
// 骨骼的局部上方向 - 用于 setFromUnitVectors
// const BONE_UP_AXIS = new THREE.Vector3(0, 0, 1); // 假设Z轴是骨骼的“上”方向

// --- Global Variables ---
let detector; // TensorFlow.js姿态检测器
let characterModel, characterBones = {}, initialBoneData = {}; // 3D模型和骨骼数据
let scene, camera, renderer, clock; // Three.js核心组件
let videoAspectRatio = VIDEO_WIDTH / VIDEO_HEIGHT;
let rafId; // requestAnimationFrame ID

// ***** 关键：骨骼映射 *****
// 您必须将这些字符串值更新为您的FBX模型中实际的骨骼名称。
// 请在浏览器控制台中查看 "Discovered bones:" 输出以找到正确的名称。
const boneMapping = {
    // MoveNet Keypoint : Your FBX Bone Name
    'hips': 'mixamorig_Hips',
    'left_hip': 'mixamorig_LeftUpLeg',
    'left_knee': 'mixamorig_LeftLeg',
    'left_ankle': 'mixamorig_LeftFoot',
    'right_hip': 'mixamorig_RightUpLeg',
    'right_knee': 'mixamorig_RightLeg',
    'right_ankle': 'mixamorig_RightFoot',
    // 'spine': 'mixamorig_Spine', // 可能需要多个脊柱骨骼
    'chest': 'mixamorig_Spine2', // 或 'mixamorig_Chest'
    'neck': 'mixamorig_Neck',
    'head': 'mixamorig_Head',
    'left_shoulder': 'mixamorig_LeftShoulder', // 在某些绑定中可能是锁骨
    'left_arm': 'mixamorig_LeftArm',        // 上臂骨骼
    'left_elbow': 'mixamorig_LeftForeArm',   // 前臂骨骼 (MoveNet的elbow关键点通常用于定位此前臂)
    'left_wrist': 'mixamorig_LeftHand',
    'right_shoulder': 'mixamorig_RightShoulder',
    'right_arm': 'mixamorig_RightArm',
    'right_elbow': 'mixamorig_RightForeArm',
    'right_wrist': 'mixamorig_RightHand',
};

// --- Three.js Initialization ---
function initThree() {
    statusElement.textContent = '初始化3D场景...';
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x333842);
    clock = new THREE.Clock();

    const containerRect = canvasContainer.getBoundingClientRect();
    const aspect = containerRect.width / containerRect.height;
    camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000);
    camera.position.set(0, 1.6, 3); // 调整相机位置以便很好地观察模型
    camera.lookAt(0, 1, 0);       // 观察点大约在模型腰部

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(containerRect.width, containerRect.height);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    canvasContainer.innerHTML = ''; // 清空容器，以防重复添加canvas
    canvasContainer.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.9);
    directionalLight.position.set(3, 10, 7);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 1024;
    directionalLight.shadow.mapSize.height = 1024;
    scene.add(directionalLight);

    const groundGeo = new THREE.PlaneGeometry(20, 20);
    const groundMat = new THREE.MeshPhongMaterial({ color: 0x444444, depthWrite: true });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // 可选: OrbitControls 用于调试
    // const controls = new OrbitControls(camera, renderer.domElement);
    // controls.target.set(0, 1, 0);
    // controls.update();

    window.addEventListener('resize', onWindowResize);
    statusElement.textContent = '3D场景初始化完毕。';
}

function onWindowResize() {
    const containerRect = canvasContainer.getBoundingClientRect();
    if (containerRect.width === 0 || containerRect.height === 0) return; // 容器不可见时不更新

    camera.aspect = containerRect.width / containerRect.height;
    camera.updateProjectionMatrix();
    renderer.setSize(containerRect.width, containerRect.height);
}

// --- Load FBX Model ---
async function loadFBXModel(path) {
    statusElement.textContent = '正在加载3D模型 (' + path + ')...';
    // **** 关键改动：直接使用导入的 FBXLoader ****
    const loader = new FBXLoader();
    return new Promise((resolve, reject) => {
        loader.load(path, (fbx) => {
            characterModel = fbx;
            characterModel.scale.set(0.01, 0.01, 0.01); // 根据您的模型调整缩放
            characterModel.position.set(0, 0, 0);     // 根据您的模型调整位置 (通常Y为0使其站在地面上)

            characterBones = {}; // 重置
            initialBoneData = {};

            characterModel.traverse(function (child) {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                    if (child.material) { // 确保材质存在
                        if (Array.isArray(child.material)) {
                            child.material.forEach(m => { if(m.isMeshStandardMaterial) m.metalness = 0.1; });
                        } else if (child.material.isMeshStandardMaterial) {
                            child.material.metalness = 0.1;
                        }
                     }
                }
                if (child.isBone) {
                    characterBones[child.name] = child;
                    initialBoneData[child.name] = {
                        initialQuaternion: child.quaternion.clone(),
                        // parent: child.parent // 可以存储父对象用于更复杂的计算
                    };
                }
            });

            console.log("Discovered bones:", Object.keys(characterBones));
            if (Object.keys(characterBones).length === 0) {
                console.warn("模型中未找到骨骼！请确保FBX文件已绑定骨骼。");
            } else {
                let allMappedBonesFound = true;
                for (const key in boneMapping) {
                    if (boneMapping[key] && !characterBones[boneMapping[key]]) {
                        console.warn(`映射警告: FBX模型中未找到骨骼 '${boneMapping[key]}' (对应关键点 '${key}')`);
                        allMappedBonesFound = false;
                    }
                }
                statusElement.textContent = allMappedBonesFound ? '3D模型加载并解析完毕。' : "警告: 部分骨骼映射名在模型中未找到。";
            }
            scene.add(characterModel);
            resolve(fbx);
        },
        (xhr) => { statusElement.textContent = `加载3D模型: ${Math.round((xhr.loaded / xhr.total) * 100)}%`; },
        (error) => {
            console.error("FBX加载错误:", error);
            statusElement.textContent = 'FBX模型加载失败。';
            reject(error);
        });
    });
}

// --- Webcam and Pose Detection Setup ---
async function setupWebcam() {
    statusElement.textContent = '请求摄像头权限...';
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
        statusElement.textContent = '摄像头权限失败。';
        alert('摄像头访问被拒绝或不可用。请检查浏览器设置并刷新页面。');
        throw e;
    }
}

async function loadPoseDetector() {
    statusElement.textContent = '加载姿态识别模型...';
    // TensorFlow.js 后端和模型加载
    // @ts-ignore
    await tf.setBackend('wasm'); // 或者 'webgl'
    // @ts-ignore
    await tf.ready();
    // @ts-ignore
    const model = poseDetection.SupportedModels.MoveNet;
    detector = await poseDetection.createDetector(model, {
        // @ts-ignore
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING, // 或 THUNDER
        // enableSmoothing: true // 可以考虑开启
    });
    statusElement.textContent = '姿态模型加载完毕。';
}

// --- Pose to 3D Model Animation Logic (Simplified) ---
function getKeypointsMap(pose) {
    const map = new Map();
    if (pose && pose.keypoints) {
        pose.keypoints.forEach(kp => map.set(kp.name, kp));
    }
    return map;
}

// 辅助函数：从2D关键点获取伪3D世界方向向量 (需要大量调整以匹配模型和场景)
function getDirectionVector(kpName1, kpName2, keypointsMap, poseCenterZ = 0.0) {
    const p1 = keypointsMap.get(kpName1);
    const p2 = keypointsMap.get(kpName2);

    if (!p1 || p1.score < 0.2 || !p2 || p2.score < 0.2) return null; // 置信度阈值

    // 假设视频流在videoElement中没有CSS镜像，MoveNet输出的是基于原始视频帧的坐标
    // 如果videoElement在CSS中镜像了，而MoveNet未镜像，那么X坐标需要翻转
    // 这里我们假设最终的X坐标是“屏幕所见”的镜像（即用户挥右手，模型同侧的肢体动）
    const p1x = VIDEO_WIDTH - p1.x; // 翻转X坐标以匹配用户视觉
    const p2x = VIDEO_WIDTH - p2.x;

    // 将2D关键点转换为一个简化的3D空间向量
    // X, Y 归一化到 [-1, 1] 或类似范围，Z 来自MoveNet (相对深度)
    // 这些缩放因子 (X_SCALE, Y_SCALE, Z_SCALE) 需要根据模型大小和相机视野进行大量调整！
    const X_SCALE = 2.0; // 场景宽度的大致范围
    const Y_SCALE = 2.0; // 场景高度的大致范围
    const Z_SCALE = 1.0; // Z深度的缩放

    const v1 = new THREE.Vector3(
        (p1x / VIDEO_WIDTH - 0.5) * X_SCALE,
        (1 - p1.y / VIDEO_HEIGHT - 0.5) * Y_SCALE, // Y轴翻转并居中
        (p1.z || 0) * Z_SCALE + poseCenterZ
    );
    const v2 = new THREE.Vector3(
        (p2x / VIDEO_WIDTH - 0.5) * X_SCALE,
        (1 - p2.y / VIDEO_HEIGHT - 0.5) * Y_SCALE,
        (p2.z || 0) * Z_SCALE + poseCenterZ
    );
    return v2.clone().sub(v1).normalize();
}

// 更新骨骼朝向 (简化版)
function updateBoneTransform(boneNameKey, startKp, endKp, keypointsMap, poseCenterZ) {
    const boneMappedName = boneMapping[boneNameKey];
    const bone = characterBones[boneMappedName];
    const initialData = initialBoneData[boneMappedName];

    if (!bone || !initialData) return;

    const targetWorldDirection = getDirectionVector(startKp, endKp, keypointsMap, poseCenterZ);
    if (!targetWorldDirection) { // 如果无法获取方向，则尝试恢复初始姿态
        // bone.quaternion.slerp(initialData.initialQuaternion, 0.1); // 平滑恢复
        return;
    }

    const parent = bone.parent;
    const parentWorldInverse = new THREE.Matrix4();
    if (parent && parent.isObject3D) { // 确保父对象是Object3D以获取matrixWorld
        parentWorldInverse.copy(parent.matrixWorld).invert();
    }
    // 如果没有有效父对象或父对象不是Object3D (例如直接是Scene)，则parentWorldInverse保持为单位矩阵

    const localTargetDirection = targetWorldDirection.clone().transformDirection(parentWorldInverse);

    // 从BONE_PRIMARY_AXIS（骨骼的静止局部指向）旋转到localTargetDirection
    const rotation = new THREE.Quaternion().setFromUnitVectors(BONE_PRIMARY_AXIS.clone(), localTargetDirection.normalize());
    bone.quaternion.copy(initialData.initialQuaternion).multiply(rotation);
}


function updateCharacterPose(pose) {
    if (!characterModel || Object.keys(characterBones).length === 0 || !pose) return;

    const keypointsMap = getKeypointsMap(pose);

    const lh = keypointsMap.get('left_hip');
    const rh = keypointsMap.get('right_hip');
    let poseCenterZ = 0.0; // 默认Z偏移
    if (lh && rh && lh.score > 0.3 && rh.score > 0.3 && typeof lh.z === 'number' && typeof rh.z === 'number') {
        // MoveNet的Z值通常是以臀部中心为0，向前为负，向后为正，且范围可能较大。
        // 我们需要将其规范化并可能缩放到适合我们场景的范围。
        // 这里的计算方式非常依赖于具体模型和场景设置。
        poseCenterZ = -((lh.z + rh.z) / 2) * 0.002; // 示例：取平均并缩放，负号可能用于调整前后
    }

    // 躯干和臀部 (非常简化, 实际效果依赖骨骼命名和层级)
    const hipsBoneName = boneMapping['hips'];
    const chestBoneName = boneMapping['chest']; // 或 'spine'
    if (hipsBoneName && characterBones[hipsBoneName] && initialBoneData[hipsBoneName]) {
        // 尝试根据左右肩和左右臀的中心点来轻微调整臀部/躯干的朝向
        // 这部分逻辑非常复杂，难以用简单方式完美实现，以下为概念性代码
        const ls = keypointsMap.get('left_shoulder');
        const rs = keypointsMap.get('right_shoulder');
        if (ls && rs && lh && rh) {
            const shoulderMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2, z: (ls.z + rs.z) / 2 };
            const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2, z: (lh.z + rh.z) / 2 };
            // 可以用 hipMid -> shoulderMid 向量来影响hips或spine的旋转，但这需要精确的骨骼轴对齐
        }
    }


    // 四肢
    updateBoneTransform('left_arm', 'left_shoulder', 'left_elbow', keypointsMap, poseCenterZ);
    updateBoneTransform('left_elbow', 'left_elbow', 'left_wrist', keypointsMap, poseCenterZ);
    updateBoneTransform('right_arm', 'right_shoulder', 'right_elbow', keypointsMap, poseCenterZ);
    updateBoneTransform('right_elbow', 'right_elbow', 'right_wrist', keypointsMap, poseCenterZ);

    updateBoneTransform('left_hip', 'left_hip', 'left_knee', keypointsMap, poseCenterZ);
    updateBoneTransform('left_knee', 'left_knee', 'left_ankle', keypointsMap, poseCenterZ);
    updateBoneTransform('right_hip', 'right_hip', 'right_knee', keypointsMap, poseCenterZ);
    updateBoneTransform('right_knee', 'right_knee', 'right_ankle', keypointsMap, poseCenterZ);

    // 头部
    const headBone = characterBones[boneMapping['head']];
    const neckBone = characterBones[boneMapping['neck']];
    const nose = keypointsMap.get('nose');

    if (headBone && initialBoneData[boneMapping['head']] && nose && nose.score > 0.3) {
        const ls = keypointsMap.get('left_shoulder');
        const rs = keypointsMap.get('right_shoulder');
        if (ls && rs) {
            const shoulderMidY = (ls.y + rs.y) / 2;
            // 简化头部倾斜和摇摆
            const headTilt = -(nose.y - shoulderMidY) * 0.003; // Y方向差异影响X轴旋转 (上下看)
            const headPan = (VIDEO_WIDTH/2 - (VIDEO_WIDTH - nose.x)) * 0.003; // X方向差异影响Y轴旋转 (左右看)

            const initialRot = initialBoneData[boneMapping['head']].initialQuaternion;
            const tiltQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), headTilt);
            const panQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), headPan);
            headBone.quaternion.copy(initialRot).multiply(panQuat).multiply(tiltQuat);

            if (neckBone && initialBoneData[boneMapping['neck']]) {
                 // 脖子稍微跟随头部
                neckBone.quaternion.copy(initialBoneData[boneMapping['neck']].initialQuaternion).slerp(headBone.quaternion, 0.5);
            }
        }
    }
}

// --- Main Animation Loop ---
async function predictAndAnimate() {
    if (!detector || !characterModel || videoElement.readyState < HTMLMediaElement.HAVE_METADATA || videoElement.paused || videoElement.ended) {
        rafId = requestAnimationFrame(predictAndAnimate);
        return;
    }

    try {
        const poses = await detector.estimatePoses(videoElement, {
            flipHorizontal: false // MoveNet通常期望非镜像输入
        });

        if (poses && poses.length > 0) {
            updateCharacterPose(poses[0]);
        }
    } catch (error) {
        console.error("姿态估计或动画更新错误:", error);
    }

    // 如果使用了 AnimationMixer (FBX内嵌动画)，在这里更新：
    // if (mixer) mixer.update(clock.getDelta());

    renderer.render(scene, camera);
    rafId = requestAnimationFrame(predictAndAnimate);
}

// --- Application Start ---
async function main() {
    statusElement.textContent = '应用启动中...';
    try {
        initThree(); // 初始化3D场景
        await loadPoseDetector(); // 加载姿态检测模型
        await setupWebcam(); // 设置摄像头
        await loadFBXModel(MODEL_PATH); // 加载FBX模型

        statusElement.textContent = '准备就绪，请开始动作！';
        predictAndAnimate(); // 开始主循环

    } catch (error) {
        console.error("初始化主流程失败:", error);
        statusElement.textContent = `初始化失败: ${error.message || error}`;
    }
}

// --- Event Listeners ---
window.addEventListener('load', main);

window.addEventListener('beforeunload', () => {
    if (rafId) {
        cancelAnimationFrame(rafId);
    }
    if (detector) {
        // @ts-ignore
        detector.dispose(); // 清理detector
    }
    if (videoElement.srcObject) {
        // @ts-ignore
        videoElement.srcObject.getTracks().forEach(track => track.stop()); // 停止摄像头
    }
