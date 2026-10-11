"""100 labelled Chinese retrieval cases on real Hindsight, bundled CPU models.

Synthetic source facts, provider=none (verbatim ingest). This isolates retrieval
quality from provider-specific extraction. No paid calls or live user data.
"""
import asyncio
import json
import logging
import os
from pathlib import Path
import tempfile
import uuid

# Each pair is an independently labelled source and paraphrased query. Entities
# deliberately repeat across facts; a name match alone does not satisfy recall.
CASES = [
 ("小林", [("每天早上七点沿湖慢跑。", "小林通常几点开始跑步？"), ("膝盖不适时改骑自行车，不进行跑步。", "小林跑不了的时候换成什么运动？"), ("最近一次十公里比赛用了五十二分钟。", "小林的十公里完赛用时是多少？"), ("运动后爱吃香蕉配无糖酸奶。", "小林锻炼结束后怎么补充食物？"), ("准备在十一月参加半程马拉松。", "小林打算何时参加半马？")]),
 ("周宁", [("学习日语时使用间隔重复单词卡。", "周宁用什么方法记外语词汇？"), ("日语听力每天练习二十分钟。", "周宁一天花多久练听力？"), ("想在明年通过日语N2考试。", "周宁的日语考试目标是什么？"), ("不喜欢只抄写单词的学习方法。", "周宁排斥哪种背单词方式？"), ("周末参加社区日语口语角。", "周宁周末去哪里练习说日语？")]),
 ("青禾项目", [("后端采用Python和FastAPI。", "青禾服务端使用哪些技术？"), ("前端采用React与TypeScript。", "青禾网页界面是用什么写的？"), ("数据库使用PostgreSQL，不使用MySQL。", "青禾持久化选的是哪种关系数据库？"), ("所有修改合并前必须经过代码审查。", "青禾的代码进入主分支之前要走什么流程？"), ("计划在十二月十五日发布测试版。", "青禾测试版本的预计上线日期是什么？")]),
 ("陈舟", [("摄影相机是富士X-T5。", "陈舟使用哪一款相机拍照？"), ("拍人像常用五十六毫米定焦镜头。", "陈舟拍摄人物时偏爱什么焦距？"), ("不希望照片自动上传到公共网站。", "陈舟对照片公开上传有什么限制？"), ("原始照片备份到家里的NAS。", "陈舟把摄影原片存在哪个备份设备？"), ("每周六清晨去湿地拍鸟。", "陈舟何时去什么地方进行鸟类摄影？")]),
 ("南星", [("喜欢低盐清淡的晚餐。", "南星晚饭口味上有什么偏好？"), ("对花生过敏，菜里不能放花生。", "南星需要避免哪种食材？"), ("午饭通常在公司食堂吃。", "南星工作日中午在哪里就餐？"), ("家里烤箱最高可以设到两百三十度。", "南星的烘焙设备温度上限是多少？"), ("周日下午集中准备一周的食物。", "南星什么时候做接下来几天的备餐？")]),
 ("许岚", [("去杭州的高铁票订在十月二十日。", "许岚哪天坐动车前往杭州？"), ("杭州行程住在西湖附近的酒店。", "许岚旅行的住宿地点靠近哪里？"), ("这次旅行的总预算为三千元。", "许岚这趟出行准备花多少钱？"), ("不安排夜间爬山活动。", "许岚有哪些不接受的晚间旅游活动？"), ("返程航班起飞时间是晚上八点。", "许岚回来的飞机几点离开？")]),
 ("松风工作室", [("会议固定在周二上午十点。", "松风团队每周什么时候开会？"), ("设计文件统一保存在共享NAS。", "松风的团队设计稿储存位置是什么？"), ("客户沟通由联系人顾凡负责。", "松风谁负责对接客户？"), ("交付文件要求PDF格式。", "松风向客户提供的最终文件要用什么格式？"), ("草稿不允许发送给外部客户。", "松风对未定稿资料的外发有什么约束？")]),
 ("陆遥", [("阅读器是Kindle Paperwhite。", "陆遥平时在哪种电子设备上看书？"), ("每晚睡前阅读半小时。", "陆遥每天给睡前阅读留多久？"), ("喜欢推理小说而不喜欢恐怖小说。", "陆遥偏爱和不喜欢的小说类型是什么？"), ("读书笔记采用Markdown保存。", "陆遥用什么文档格式记录阅读心得？"), ("正在读三体第二部黑暗森林。", "陆遥目前正在阅读哪本书？")]),
 ("北辰实验", [("样品编号为BC-27。", "北辰正在分析的材料样品用什么编号？"), ("实验温度设定为八十摄氏度。", "北辰的反应加热条件是多少度？"), ("原始测量数据禁止覆盖。", "北辰对已有实验数据的修改有什么限制？"), ("分析结果使用Python绘图。", "北辰用哪种编程语言生成分析图表？"), ("复测安排在周五下午两点。", "北辰重复测量的计划时间是什么？")]),
 ("顾远", [("主要使用Windows笔记本办公。", "顾远的主要工作电脑运行什么系统？"), ("远程服务器地址通过私有设备目录管理。", "顾远把远端机器的连接信息放在哪里管理？"), ("设备文件只允许只读访问。", "顾远对机器上的文件开放什么权限？"), ("重要文档每晚自动备份一次。", "顾远的关键资料多久备份一次？"), ("终端命令必须在自己的联系人页面批准。", "顾远希望在哪里确认执行命令？")]),
 ("叶青", [("钢琴练习每天四十五分钟。", "叶青一天练琴多长时间？"), ("目前学习肖邦夜曲。", "叶青现在练习哪位作曲家的什么作品？"), ("电子钢琴连接耳机练习。", "叶青如何让练琴不影响邻居？"), ("不接受清晨六点以前的课程。", "叶青对上午课程的最早时间有什么限制？"), ("每周三晚上跟老师上课。", "叶青的音乐课安排在什么时候？")]),
 ("远山账号", [("发布内容主要讲解植物养护。", "远山的自媒体专注哪个主题？"), ("视频成片长度控制在三分钟以内。", "远山希望成品视频最长多久？"), ("封面使用墨绿色背景。", "远山账号的图片封面是什么底色？"), ("不在视频中出现真实家庭地址。", "远山公开视频不能透露哪些住址信息？"), ("每周一和周四更新。", "远山通常一周哪几天发布内容？")]),
 ("苏曼", [("养了一只名叫豆豆的橘猫。", "苏曼的宠物是什么动物叫什么？"), ("猫粮选择无谷配方。", "苏曼给宠物选购食物有什么配方偏好？"), ("猫咪体检预约在十一月三日。", "苏曼什么时候带猫做检查？"), ("不允许猫进入书房。", "苏曼家里哪间房禁止宠物进入？"), ("宠物照片保存在猫咪相册中。", "苏曼把猫的图片整理在哪个相册？")]),
 ("云帆课程", [("学生面向零基础编程初学者。", "云帆教学的对象需要有什么编程基础？"), ("课程例子统一使用JavaScript。", "云帆用哪门语言展示教学示例？"), ("每节课持续九十分钟。", "云帆单次课堂的时长是多少？"), ("作业不能包含真实用户数据。", "云帆布置练习时对个人数据有什么要求？"), ("课件在周日晚上发送。", "云帆什么时候向学生提供幻灯片？")]),
 ("柏川", [("通勤通常乘坐地铁二号线。", "柏川上班主要坐哪条公共交通线路？"), ("从家到公司需要四十分钟。", "柏川的单程上班路程耗时多久？"), ("周五在家远程办公。", "柏川哪天不需要去办公室？"), ("不希望收到晚上十点后的通知。", "柏川的消息免打扰从几点开始？"), ("工作日早晨八点出门。", "柏川平时几点离家去上班？")]),
 ("清泉花园", [("阳台种植薄荷和罗勒。", "清泉阳台栽培了哪些香草？"), ("夏季每天清晨浇水。", "清泉在炎热季节什么时候给植物补水？"), ("不使用化学除草剂。", "清泉花园禁止使用哪类园艺药剂？"), ("花盆采用底部带孔的陶盆。", "清泉为植物选择了什么材质结构的容器？"), ("冬季把植物移到室内南窗。", "清泉如何安排植物过冬的位置？")]),
 ("星桥会议", [("参会人员共十二人。", "星桥这场会议有多少人参加？"), ("会议地点为三楼松柏厅。", "星桥活动具体在哪层哪个房间？"), ("演示环节限时十五分钟。", "星桥每次展示可以讲多久？"), ("不允许录制包含客户信息的片段。", "星桥对会议录像有什么保密要求？"), ("最终纪要由联系人白宁整理。", "星桥谁负责编写会后记录？")]),
 ("蓝湾应用", [("应用界面默认使用中文。", "蓝湾首次启动显示哪种语言？"), ("所有时间按照上海时区显示。", "蓝湾日期时间依据哪个地区的时区？"), ("数据默认保存到主设备本地。", "蓝湾的用户资料通常存在哪台机器？"), ("新安装时不创建任何默认Agent。", "蓝湾刚装好时是否会生成预设助手？"), ("危险操作需要由执行者提出批准请求。", "蓝湾执行高风险动作时由谁发起确认？")]),
 ("秦墨", [("喜欢用深色主题编写代码。", "秦墨对开发界面的颜色风格有什么偏好？"), ("缩进统一使用四个空格。", "秦墨希望代码缩进宽度是多少？"), ("变量名使用英文小写加下划线。", "秦墨采用哪一种变量命名格式？"), ("禁止将密钥提交到版本仓库。", "秦墨有哪些信息不能加入Git提交？"), ("提交之前先运行单元测试。", "秦墨在保存代码版本前要求做什么验证？")]),
 ("白露计划", [("每月第二个周六整理家庭文件。", "白露的家庭资料整理安排在哪一天？"), ("账单保留最近五年的记录。", "白露保存财务单据需要覆盖多长历史？"), ("扫描文件分辨率为三百DPI。", "白露将纸质文件数字化时选择多高清晰度？"), ("身份证扫描件只放入加密目录。", "白露把身份文件的电子版保存在什么地方？"), ("不用的临时文件需确认后才能删除。", "白露清理临时资料前有哪些要求？")]),
]

async def main():
    logging.disable(logging.CRITICAL)
    resources = Path(__file__).resolve().parents[1] / "dist-personal/memory-runtime"
    report = Path(__file__).resolve().parents[1] / "release/personal-os/chinese-memory-quality.json"
    report.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="nex-chinese-quality-") as temporary:
        data = Path(temporary)
        for key in list(os.environ):
            if key.startswith("HINDSIGHT_"): del os.environ[key]
        os.environ.update({"HOME": str(data), "USERPROFILE": str(data), "LOCALAPPDATA": str(data), "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HINDSIGHT_API_LLM_PROVIDER": "none", "HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION": "false", "HINDSIGHT_API_TEXT_SEARCH_EXTENSION": "native", "HINDSIGHT_API_SKIP_LLM_VERIFICATION": "true"})
        import torch
        torch.set_num_threads(4)
        from pg0 import Pg0
        from hindsight_api import MemoryEngine
        from hindsight_api.api.http import create_app
        from hindsight_api.engine.embeddings import LocalSTEmbeddings
        from hindsight_api.engine.cross_encoder import LocalSTCrossEncoder
        import httpx
        pg = Pg0(name="nex-quality-" + uuid.uuid4().hex, data_dir=str(data / "pg"), config={"listen_addresses": "127.0.0.1", "max_connections": "20"})
        engine = None
        try:
            info = await asyncio.to_thread(pg.start)
            engine = MemoryEngine(db_url=info.uri, memory_llm_provider="none", embeddings=LocalSTEmbeddings(model_name=str(resources / "models/embeddings"), force_cpu=True), cross_encoder=LocalSTCrossEncoder(model_name=str(resources / "models/reranker"), force_cpu=True, max_concurrent=1), skip_llm_verification=True, pool_min_size=1, pool_max_size=4)
            await engine.initialize()
            client = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(engine, initialize_memory=False)), base_url="http://fixture", timeout=120)
            async with client:
                await client.put("/v1/default/banks/quality", json={"name": "Synthetic Chinese evaluation"})
                rows = [{"id": f"case-{group}-{index}", "content": name + "：" + fact, "query": query} for group, (name, pairs) in enumerate(CASES) for index, (fact, query) in enumerate(pairs)]
                for row in rows:
                    response = await client.post("/v1/default/banks/quality/memories", json={"async": False, "items": [{"content": row["content"], "document_id": row["id"]}]})
                    response.raise_for_status()
                print("100 synthetic source documents ingested", flush=True)
                results = []
                for index, row in enumerate(rows):
                    response = await client.post("/v1/default/banks/quality/memories/recall", json={"query": row["query"], "budget": "mid", "max_tokens": 5000, "types": ["world", "experience"]})
                    response.raise_for_status()
                    candidates = [fact.get("document_id") for fact in response.json()["results"][:10]]
                    baseline = [other["id"] for other in rows if row["query"] in other["content"]][:10]
                    results.append({"id": row["id"], "query": row["query"], "expected": row["id"], "top10": candidates, "hit": row["id"] in candidates, "likeHit": row["id"] in baseline})
                    if (index + 1) % 10 == 0: print(f"Evaluated {index + 1}/100", flush=True)
                score = sum(r["hit"] for r in results) / len(results)
                like = sum(r["likeHit"] for r in results) / len(results)
                result = {"release": "0.10.3", "queries": len(results), "recallAt10": score, "likeRecallAt10": like, "passed": len(results) == 100 and score >= .85 and score - like >= .20, "limits": "synthetic labelled corpus, verbatim ingestion; evaluates genuine retrieval, not paid-provider extraction or broad real-world quality", "models": json.loads((resources / "runtime.json").read_text())["models"]["revisions"], "results": results}
                report.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                print(json.dumps({k: v for k, v in result.items() if k != "results"}, ensure_ascii=False), flush=True)
                assert result["passed"], "Chinese retrieval release gate failed"
        finally:
            if engine: await engine.close()
            await asyncio.to_thread(pg.stop)

if __name__ == "__main__": asyncio.run(main())
