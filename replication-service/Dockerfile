FROM python:3.8.7-slim-buster

# RUN apk update \
#   && apk add --virtual build-deps gcc python3-dev musl-dev \
#   && apk add postgresql-dev \
#   && pip3 install psycopg2-binary \
#   && pip3 install psycopg2 \
#   && apk del build-deps

ENV PYTHONUNBUFFERED=1

RUN : \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        gcc \
        libpq-dev \
        libpq5 \
        python3-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && :
    
ADD . /app
WORKDIR /app
RUN pip3 install -r requirements.txt

CMD [ "/usr/local/bin/python3","app.py" ]