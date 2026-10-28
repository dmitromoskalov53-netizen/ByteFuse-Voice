import os,subprocess,urllib.request
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
u=os.environ["VOICEOVER_URL"]
if not u.startswith("https://ai-voiceovers.s3.") or ".amazonaws.com/" not in u.split("?")[0]: raise ValueError("Expected vidIQ S3 audio URL")
p=Path("output");p.mkdir(exist_ok=True)
with urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"ByteFuse/1.0"}),timeout=60) as r: data=r.read(15000001)
if len(data)<1000 or len(data)>15000000: raise ValueError("Invalid MP3")
(p/"voice.mp3").write_bytes(data)
duration=float(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",str(p/"voice.mp3")],text=True))
slides=[
("EMAIL TAKING TOO LONG?",["Stop rewriting","the same email."]),
("THE CHATGPT TRICK",["Make any message","sound professional."]),
("BEFORE",["Hey Alex,","I need the report.","Send it today."]),
("COPY THIS PROMPT",["Rewrite this email to sound","polite, clear, and professional.","Keep it short.","Don't change the meaning."]),
("AFTER",["Hi Alex, could you please","send me the report today?","Thanks so much for your help."]),
("SAME REQUEST",["Better tone.","Clearer message."]),
("ONE MORE TRICK",["Ask for a friendlier","or more direct version."]),
("BYTEFUSE LAB",["Save this trick.","Follow for practical AI tips."])]
weights=[4.5,5.8,4.2,8.2,7.8,4.3,3.6,4.2]
f=p/"slides.ffconcat"
with f.open("w") as m:
 m.write("ffconcat version 1.0\n")
 for i,((head,lines),w) in enumerate(zip(slides,weights)):
  im=Image.new("RGB",(1080,1920),(9,18,35));d=ImageDraw.Draw(im)
  d.rounded_rectangle((65,100,1015,1815),radius=48,fill=(17,32,56),outline=(32,99,123),width=4)
  font="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
  small=ImageFont.truetype(font,27);h=ImageFont.truetype(font,54);body=ImageFont.truetype(font,44)
  d.text((105,155),"BYTEFUSE LAB  /  AI SHORTS",font=small,fill=(100,227,235))
  d.text((105,355),head,font=h,fill=(91,224,234))
  for j,line in enumerate(lines):d.text((105,600+j*108),line,font=body,fill=(239,245,255))
  d.text((105,1670),f"BYTEFUSE LAB  •  {i+1:02d} / 08",font=small,fill=(143,171,193))
  img=p/f"slide_{i:02d}.png";im.save(img)
  m.write(f"file '{img.resolve()}'\nduration {duration*w/sum(weights):.5f}\n")
 m.write(f"file '{(p/'slide_07.png').resolve()}'\n")
subprocess.run(["ffmpeg","-y","-hide_banner","-loglevel","error","-safe","0","-f","concat","-i",str(f),"-i",str(p/"voice.mp3"),"-vf","fps=30,format=yuv420p","-c:v","libx264","-preset","veryfast","-crf","20","-c:a","aac","-b:a","192k","-af","loudnorm=I=-16:TP=-1.5:LRA=11","-t",str(duration),"-movflags","+faststart",str(p/"ByteFuse_Lab_Short_03_FINAL.mp4")],check=True)
print("Rendered video, duration",round(duration,2))
