// --- utility methods ---
var range = function (n) {
    var r = [];
    for (var i = 0; i < n; i++) {
        r.push(i);
    }
    return r;
};
var contains = function (array, value) {
    for (var k in array) {
        if (array[k] == value) {
            return true;
        }
    }
    return false;
};
Number.prototype.range = function () {
    return range(this);
};

// --- secret sharing methods ---
var mod5 = function (v) {
    v %= 5;
    if (v < 0) v += 5;
    return v;
};
var splitSecretIntoShares = function (secret) {
    var d = Math.floor(Math.random() * 5);
    return range(3).map(function (i) {
        return secret + d * (i + 1);
    }).map(mod5);
};
var combineSharesIntoSecret = function (shares) {
    return mod5(shares[0] * 3 + shares[1] * 2 + shares[2] * 1);
};

// --- player interaction (movement and SMPC) ---
var areaWidth = 12;
var areaHeight = 12;
var makeAreaGrid = function () {
    return areaWidth.range().map(function (i1) {
        return areaHeight.range().map(function (i2) {
            return -1;
        });
    });
};
var players = [];
players = range(3).map(function (i) {
    return {
        id: i,
        x: 0,
        y: 0,
        dx: 1,
        dy: 0,
        latestArea: makeAreaGrid(),
        
        // messages that have arrived, withing to be consumed by actions
        messageQueues: [
            [],
            [],
            []
        ],
        // queued actions to take once messages arrive
        onMessageQueues: [
            [],
            [],
            []
        ],
        // the player's portion of the stack of the SMPC virtual machine
        valueStack: [],
        // queued operations for the VM to perform once previous operations finish
        onOperationQueue: [],
        
        // determines visibility around the player character
        canSee: function (x, y) {
            var ux = x - this.x;
            var uy = y - this.y;

            // loop around to see other side
            if (ux > areaWidth / 2) ux -= areaWidth;
            if (ux < -areaWidth / 2) ux += areaWidth;
            if (uy > areaHeight / 2) uy -= areaHeight;
            if (uy < -areaHeight / 2) uy += areaHeight;

            // reduce to facing-right case
            if (this.dx !== 0) ux *= this.dx;
            if (this.dy !== 0) {
                uy *= this.dy;
                var t = ux;
                ux = uy;
                uy = t;
            }

            // see not quite as far to the sides and back
            if (ux < 0) ux *= 1.5;
            uy *= 2;

            return ux * ux + uy * uy < 30;
        },
        
        // changes the position of the player's character
        move: function (dir) {
            var tx = 0;
            var ty = 0;
            if (dir == "left") {
                tx = -1;
            } else if (dir == "up") {
                ty = -1;
            } else if (dir == "right") {
                tx = 1;
            } else if (dir == "down") {
                ty = 1;
            }
            if (tx !== 0 || ty !== 0) {
                this.dx = tx;
                this.dy = ty;
                var nx = (this.x + tx) % areaWidth;
                var ny = (this.y + ty) % areaHeight;
                if (nx < 0) nx += areaWidth;
                if (ny < 0) ny += areaHeight;

                if (this.latestArea[nx][ny] !== 0) return;
                for (var i in players) {
                    if (players[i].x == nx && players[i].y == ny) return;
                }
                this.x = nx;
                this.y = ny;
            }
        },
        
        // enqueues an action to perform once a message has arrived from the given sender
        // if there's already a message queued, just runs the action inline
        doOnReceive: function (senderId, action) {
            if (this.messageQueues[senderId].length > 0) {
                action(this.messageQueues[senderId].shift());
            } else {
                this.onMessageQueues[senderId].push(action);
            }
        },
        
        // queues a message on self from the given sender
        // if there's already a message action queued, the message is consumed immediately
        transmit: function (senderId, message) {
            if (this.onMessageQueues[senderId].length > 0) {
                this.onMessageQueues[senderId].shift()(message);
            } else {
                this.messageQueues[senderId].push(message);
            }
        },
        
        // queues an operation to perform or, if none is running, starts the given operation
        // must call doneOperation once the operation is finished
        doStartOperationAfterPrevious: function (action) {
            this.onOperationQueue.push(action);
            if (this.onOperationQueue.length == 1) {
                action();
            }
        },
        
        // runs the next queued operation, if there is one
        doneOperation: function () {
            this.onOperationQueue.shift();
            if (this.onOperationQueue.length > 0) {
                this.onOperationQueue[0]();
            }
        },
        
        // VM operation: the given sender splits a private input value
        // the value enters the VM and is pushed onto the stack
        // (all players must run opPushPrivateInput, but the inputValue arg is ignored for non-senders)
        opPushPrivateInput: function (senderId, inputValue) {
            var self = this;
            self.doStartOperationAfterPrevious(function () {
                if (senderId == self.id) {
                    var shares = splitSecretIntoShares(inputValue);
                    for (var i in range(3)) {
                        players[i].transmit(self.id, shares[i]);
                    }
                }

                self.doOnReceive(senderId, function (message) {
                    self.valueStack.push(message);
                    self.doneOperation();
                });
            });
        },
        
        // VM operation: push a value known to all players onto the VM's stack
        // (all players must run opPushConstant and give it the same value)
        opPushConstant: function (value) {
            self.doStartOperationAfterPrevious(function () {
                this.valueStack.push(value);
                self.doneOperation();
            });
        },
        
        // receive a message from each player and interpret them as shares of a secret value
        // (does not affect the VM's stack)
        opReceiveCombineIndexedShares: function (actionForValue) {
            var shares = [null, null, null];
            var n = 0;
            var self = this;
            for (var i_ in range(3)) {
                var f = function (i) {
                    self.doOnReceive(i, function (v) {
                        shares[i] = v;
                        n += 1;
                        if (n == 3) {
                            var value = combineSharesIntoSecret(shares);
                            actionForValue(value);
                        }
                    });
                };

                f(i_);
            }
        },
        
        // pop a value from the SMPC-VM's stack, and reveal it to the given players
        // (every players must run opPopRevealTo, but only receivers will get called back)
        opPopRevealTo: function (receiverIds, actionForValue) {
            var self = this;
            self.doStartOperationAfterPrevious(function () {
                if (contains(receiverIds, self.id)) {
                    self.opReceiveCombineIndexedShares(actionForValue);
                }
                var value = self.valueStack.pop();
                for (var i in receiverIds) {
                    players[receiverIds[i]].transmit(self.id, value);
                }
                self.doneOperation();
            });
        },
        
        // pops two values off the SMPC-VM's stack, adds them, and pushes the result onto the stack
        opPopPopAddPush: function () {
            var self = this;
            self.doStartOperationAfterPrevious(function () {
                var s1 = self.valueStack.pop();
                var s2 = self.valueStack.pop();
                var s3 = mod5(s1 + s2);
                self.valueStack.push(s3);
                self.doneOperation();
            });
        },
        
        // pops two values off the SMPC-VM's stack, multiplies them, and pushes the result onto the stack
        // requires a message round trip to do degree reduction
        opPopPopMultiplyPush: function () {
            var self = this;
            self.doStartOperationAfterPrevious(function () {
                var s1 = self.valueStack.pop();
                var s2 = self.valueStack.pop();
                var q = mod5(s1 * s2);
                var sq = splitSecretIntoShares(q);
                for (var i in range(3)) {
                    players[i].transmit(self.id, sq[i]);
                }
                self.opReceiveCombineIndexedShares(function (e) {
                    self.valueStack.push(e);
                    self.doneOperation();
                });
            });
        },
        
        // uses the VM to do oblivious transfer of player positions
        // for each cell, the querying player sends 0/1 based on their visibility
        // other players send 0/1 based on if they are on that cell
        // the other players' inputs are added, then multiplied against the visibility mask
        // thus only the positions of players within the visible area are transferred
        //
        // WARNING: although we COULD, to keep things we are NOT VERIFYING the inputs
        // i.e. players don't record all data and require revelation after the game to verify correct behavior
        requeryArea: function () {
            var self = this;
            var queryResult = makeAreaGrid();
            var n = 0;
            for (var queryerId in range(3)) {
                for (var a_ in areaWidth.range()) {
                    for (var b_ in areaWidth.range()) {
                        var f = function (a, b) {
                            // compute # of other players on cell (only ever 0 or 1)
                            for (var senderId in range(3)) {
                                if (queryerId == senderId) continue;
                                self.opPushPrivateInput(senderId, self.x == a && self.y == b ? 1 : 0);
                            }
                            self.opPopPopAddPush();
                            
                            // mask against visibility
                            self.opPushPrivateInput(queryerId, self.canSee(a, b) ? 1 : 0);
                            self.opPopPopMultiplyPush();

                            // querying player gets result to fill in their map
                            self.opPopRevealTo([queryerId], function (e) {
                                queryResult[a][b] = e;
                                n += 1;
                                if (n == areaWidth * areaHeight) {
                                    self.latestArea = queryResult;
                                }
                            });
                        };
                        f(a_, b_);
                    }
                }
            }
        }
    };
});

// --- initial positions ---
players[0].x = Math.round(areaWidth / 2);
players[0].y = Math.round(areaHeight / 2);
players[0].dy = 1;
players[0].dx = 0;
players[1].x = 2;
players[1].y = 2;
players[2].x = Math.round(areaWidth / 2);
players[2].y = areaHeight - 4;

// --- super fancy graphics ---
var redraw = function () {
    for (var i in players) {
        players[i].requeryArea();
    }

    var tileSpan = 25;
    var canvas = document.getElementById("gameCanvas");
    var selfimg = document.getElementById("selfimg");
    var fogimg = document.getElementById("fogimg");
    var groundimg = document.getElementById("groundimg");
    var errimg = document.getElementById("errimg");
    var otherimg = document.getElementById("otherimg");
    var sw = groundimg.width / areaWidth;
    var sh = groundimg.height / areaHeight;
    var c = canvas.getContext("2d");
    var p = players[0];
    c.drawImage(fogimg, 0, 0, areaWidth * tileSpan, areaHeight * tileSpan);
    for (i in range(areaWidth)) {
        for (var j in range(areaHeight)) {
            var x = i * tileSpan;
            var y = j * tileSpan;
            if (!p.canSee(i, j)) {
                if (p.latestArea[i][j] !== 0) {
                    // uh oh, they shouldn't see anything here!
                    c.drawImage(errimg, x, y, tileSpan, tileSpan);
                }
                continue;
            }
            if (p.latestArea[i][j] == -1) {
                // ugh, querying failed and players aren't getting results
                c.drawImage(errimg, x, y, tileSpan, tileSpan);
            } else {
                c.drawImage(groundimg,
                    i * sw,
                    j * sh,
                    sw,
                    sh,
                    x,
                    y,
                    tileSpan,
                    tileSpan);
            }

            if (p.latestArea[i][j] == 1) {
                c.drawImage(otherimg, x, y, tileSpan, tileSpan);
            }
            if (i == p.x && j == p.y) {
                c.drawImage(selfimg, x, y, tileSpan, tileSpan);
            }
        }
    }
};

// --- control ---
var pressed = [];
var keyUpHandler = function (e) {
    pressed.splice(pressed.indexOf(e.keyCode), 1);
};
var keyPressHandler = function (e) {
    // ignore held keys
    if (pressed.indexOf(e.keyCode) != -1) return;
    pressed.push(e.keyCode);

    // move player
    var p = players[0];
    if (e.keyCode == 65) {
        p.move("left");
    } else if (e.keyCode == 87) {
        p.move("up");
    } else if (e.keyCode == 68) {
        p.move("right");
    } else if (e.keyCode == 83) {
        p.move("down");
    }

    // drunken walk the other players
    for (var i = 1; i < 3; i++) {
        if (Math.random() < 0.5) continue;
        players[i].move(["left", "up", "right", "down"][Math.floor(Math.random() * 4)]);
    }
    
    redraw();
};

redraw();
document.addEventListener("keydown", keyPressHandler, false);
document.addEventListener("keyup", keyUpHandler, false);
